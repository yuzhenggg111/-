(() => {
  "use strict";

  const DB_NAME = "leanflow-dashboard";
  const DB_STORE = "app";
  const DB_KEY = "state";
  const DIRECT_AI_KEY = "leanflow-openai-key";
  const PROXY_TOKEN_KEY = "leanflow-proxy-token";
  const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const MEAL_META = {
    breakfast: { name: "早餐", glyph: "早", accent: "#e7c457" },
    lunch: { name: "午餐", glyph: "午", accent: "#9fbe6f" },
    dinner: { name: "晚餐", glyph: "晚", accent: "#d58d72" },
    snack: { name: "加餐", glyph: "加", accent: "#7fa9b8" }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const num = (value, fallback = 0) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const round = (value, digits = 0) => {
    const factor = 10 ** digits;
    return Math.round((num(value) + Number.EPSILON) * factor) / factor;
  };
  const uid = () => globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseLocalDate(dateString) {
    return new Date(`${dateString}T00:00:00`);
  }

  function addDays(dateString, amount) {
    const date = parseLocalDate(dateString);
    date.setDate(date.getDate() + amount);
    return localDateString(date);
  }

  function daysBetween(from, to) {
    return Math.round((parseLocalDate(to) - parseLocalDate(from)) / 86400000);
  }

  function formatShortDate(dateString) {
    const date = parseLocalDate(dateString);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatLongDate(dateString) {
    const date = parseLocalDate(dateString);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · ${DAY_NAMES[date.getDay()]}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readStoredState() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function writeStoredState(value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function defaultState() {
    const today = localDateString();
    return {
      version: 1,
      profile: {
        name: "我的减脂计划",
        sex: "female",
        height: 165,
        weight: 70,
        goalWeight: 62,
        weeklyExerciseHours: 2.5,
        femaleSupport: true,
        startDate: today
      },
      settings: {
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
        connectionMode: "auto",
        proxyUrl: ""
      },
      weights: [],
      meals: [],
      dayNotes: {},
      carbModifier: 0,
      lastAutoAdjustDate: null,
      selectedMealDate: today
    };
  }

  function hydrateState(stored) {
    const base = defaultState();
    if (!stored || typeof stored !== "object") return base;
    return {
      ...base,
      ...stored,
      profile: { ...base.profile, ...(stored.profile || {}) },
      settings: { ...base.settings, ...(stored.settings || {}) },
      weights: Array.isArray(stored.weights) ? stored.weights : [],
      meals: Array.isArray(stored.meals) ? stored.meals : [],
      dayNotes: stored.dayNotes && typeof stored.dayNotes === "object" ? stored.dayNotes : {},
      carbModifier: num(stored.carbModifier),
      selectedMealDate: stored.selectedMealDate || base.selectedMealDate
    };
  }

  let state = defaultState();
  let aiHealth = { configured: false, model: state.settings.model };
  let aiMode = "unknown";
  let backendAvailable = false;
  let draftMeal = null;
  let toastTimer;
  const persistedSave = debounce(async () => {
    try {
      await writeStoredState(state);
    } catch (error) {
      console.error(error);
      showToast("本地保存失败，请检查浏览器存储空间。", true);
    }
  }, 120);

  function saveState() {
    persistedSave();
  }

  function showToast(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.style.background = isError ? "rgba(131, 53, 45, 0.96)" : "";
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function currentWeight() {
    const sorted = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
    return sorted.length ? num(sorted.at(-1).weight, state.profile.weight) : num(state.profile.weight);
  }

  function exerciseCoefficients(hours) {
    if (hours <= 3.49) return { carbs: 2.2, protein: 1.4, fat: 0.8, label: "2–3 小时" };
    if (hours <= 5.49) return { carbs: 2.5, protein: 1.6, fat: 0.9, label: "4–5 小时" };
    if (hours <= 7.49) return { carbs: 3.0, protein: 1.7, fat: 1.0, label: "6–7 小时" };
    return { carbs: 3.5, protein: 1.8, fat: 1.0, label: "8–9 小时" };
  }

  function getTargets() {
    const weight = currentWeight();
    const coefficients = exerciseCoefficients(num(state.profile.weeklyExerciseHours, 2.5));
    const femaleMode = state.profile.sex === "female" && state.profile.femaleSupport;
    const proteinCoefficient = femaleMode
      ? Math.min(coefficients.protein, 1.4)
      : coefficients.protein;
    const fatCoefficient = femaleMode
      ? Math.max(coefficients.fat, 1.0)
      : coefficients.fat;
    const carbs = Math.max(weight * 1.5, weight * coefficients.carbs + num(state.carbModifier));
    const protein = weight * proteinCoefficient;
    const fat = weight * fatCoefficient;
    return {
      weight,
      coefficients,
      carbs: Math.round(carbs),
      protein: Math.round(protein),
      fat: Math.round(fat),
      calories: Math.round(carbs * 4 + protein * 4 + fat * 9),
      femaleMode,
      proteinCoefficient,
      fatCoefficient
    };
  }

  function mealTotals(meal) {
    const totals = (meal.items || []).reduce((sum, item) => {
      sum.protein += num(item.protein);
      sum.carbs += num(item.carbs);
      sum.fat += num(item.fat);
      return sum;
    }, { protein: 0, carbs: 0, fat: 0 });
    totals.calories = Math.round(totals.protein * 4 + totals.carbs * 4 + totals.fat * 9);
    return {
      protein: round(totals.protein, 1),
      carbs: round(totals.carbs, 1),
      fat: round(totals.fat, 1),
      calories: totals.calories
    };
  }

  function dayMeals(date) {
    return state.meals
      .filter(meal => meal.date === date)
      .sort((a, b) => {
        const order = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };
        return (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.createdAt.localeCompare(b.createdAt);
      });
  }

  function dayTotals(date) {
    const totals = dayMeals(date).reduce((sum, meal) => {
      const mealValue = mealTotals(meal);
      sum.protein += mealValue.protein;
      sum.carbs += mealValue.carbs;
      sum.fat += mealValue.fat;
      sum.calories += mealValue.calories;
      return sum;
    }, { protein: 0, carbs: 0, fat: 0, calories: 0 });
    return {
      protein: round(totals.protein, 1),
      carbs: round(totals.carbs, 1),
      fat: round(totals.fat, 1),
      calories: Math.round(totals.calories)
    };
  }

  function recentWeights(days = 90) {
    const cutoff = addDays(localDateString(), -days);
    return [...state.weights]
      .filter(entry => entry.date >= cutoff)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  function weightRate(entries = state.weights) {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 2) return null;
    const first = sorted[0];
    const last = sorted.at(-1);
    const days = daysBetween(first.date, last.date);
    if (days <= 0) return null;
    return ((num(last.weight) - num(first.weight)) / num(first.weight)) * (7 / days) * 100;
  }

  function loggedDaysInRange(dates) {
    return dates.filter(date => dayMeals(date).length > 0).length;
  }

  function lastWeekDates(endDate = localDateString()) {
    return Array.from({ length: 7 }, (_, index) => addDays(endDate, index - 6));
  }

  function dailyCoach() {
    const today = localDateString();
    const totals = dayTotals(today);
    const targets = getTargets();
    const meals = dayMeals(today);
    const hour = new Date().getHours();

    if (!meals.length) {
      return "先记录第一餐，我会根据今天已吃的内容，告诉你最值得调整的一件事。";
    }
    if (totals.protein < targets.protein * 0.55 && hour >= 15) {
      return `蛋白质还差 ${Math.max(0, Math.round(targets.protein - totals.protein))} g。下一餐优先一掌心鱼虾、鸡肉或瘦牛肉。`;
    }
    if (totals.fat > targets.fat * 1.05) {
      return "脂肪已经接近或超过目标。接下来少用油、坚果和浓酱，蛋白质与蔬菜照常吃。";
    }
    if (totals.calories > targets.calories * 1.05) {
      return "今天总热量略高。不用补偿性挨饿，下一餐缩小主食和烹调油即可。";
    }
    if (totals.calories < targets.calories * 0.62 && hour >= 20) {
      return "今天吃得偏少。若并不饿可以结束；若训练后明显饥饿，补一份酸奶或水果。";
    }
    if (
      Math.abs(totals.protein - targets.protein) <= targets.protein * 0.12 &&
      Math.abs(totals.fat - targets.fat) <= targets.fat * 0.15
    ) {
      return "蛋白质和脂肪都很稳。接下来只需要把今天剩余的碳水和蔬菜安排好。";
    }
    return "记录得不错。保持稳定的三餐结构，比追求某一天的数字完美更重要。";
  }

  function insightForDay() {
    const today = localDateString();
    const totals = dayTotals(today);
    const target = getTargets();
    const caloriePct = target.calories ? totals.calories / target.calories : 0;
    if (!dayMeals(today).length) return "从一餐开始记录";
    if (caloriePct < 0.8) return "今天还有空间";
    if (caloriePct <= 1.08) return "节奏刚刚好";
    return "关注下一餐的份量";
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
  }

  function renderDashboard() {
    const today = localDateString();
    const totals = dayTotals(today);
    const targets = getTargets();
    const meals = dayMeals(today);
    const weight = currentWeight();
    const sortedWeights = recentWeights(90);
    const latestChange = sortedWeights.length >= 2
      ? num(sortedWeights.at(-1).weight) - num(sortedWeights.at(-2).weight)
      : null;

    setText("#topbar-date", formatLongDate(today));
    setText("#side-calorie-target", `${targets.calories} kcal`);
    setText("#side-target-detail", `${targets.carbs} 碳水 · ${targets.protein} 蛋白 · ${targets.fat} 脂肪`);
    setText("#hero-title", meals.length ? "把今天吃明白" : "从第一餐开始");
    setText("#hero-subtitle", `${state.profile.name}，根据当前 ${round(weight, 1)} kg 与每周 ${num(state.profile.weeklyExerciseHours)} 小时运动量计算。`);
    setText("#hero-calories", totals.calories);
    setText("#hero-calorie-target", targets.calories);
    setText("#hero-calorie-state", insightForDay());

    const orbitPct = clamp(targets.calories ? totals.calories / targets.calories : 0, 0, 1);
    $("#calorie-orbit-progress").style.strokeDashoffset = String(452.39 * (1 - orbitPct));

    renderMetric("protein", totals.protein, targets.protein, "g");
    renderMetric("carbs", totals.carbs, targets.carbs, "g");
    renderMetric("fat", totals.fat, targets.fat, "g");

    setText("#current-weight", round(weight, 1));
    setText("#weight-change", latestChange === null ? "—" : `${latestChange > 0 ? "+" : ""}${round(latestChange, 1)} kg`);
    setText("#weight-target-copy", sortedWeights.length
      ? `目标 ${round(state.profile.goalWeight, 1)} kg · 还差 ${Math.max(0, round(weight - state.profile.goalWeight, 1))} kg`
      : "记录一次体重后开始优化");

    $("#mini-weight-chart").innerHTML = buildMiniWeightChart(sortedWeights);
    setText("#daily-coach-message", dailyCoach());
    setText("#logged-meal-count", `${meals.length} 餐已记录`);
    $("#today-meals").innerHTML = renderMealList(meals, today, true);

    setText("#formula-weight", `${round(weight, 1)} kg`);
    setText("#formula-exercise", `每周 ${num(state.profile.weeklyExerciseHours)} 小时运动${targets.femaleMode ? " · 女性友好" : ""}`);
    setText("#formula-coefficients", `${targets.coefficients.carbs} / ${targets.proteinCoefficient} / ${targets.fatCoefficient}`);
    setText("#formula-modifier", `${state.carbModifier > 0 ? "+" : ""}${state.carbModifier} g 碳水`);
    setText("#formula-calories", `${targets.calories} kcal`);
  }

  function renderMetric(key, actual, target, unit) {
    const pct = target ? clamp(actual / target, 0, 1) : 0;
    const percentText = target ? `${Math.round((actual / target) * 100)}%` : "0%";
    setText(`#${key}-value`, round(actual, actual < 20 ? 1 : 0));
    setText(`#${key}-target`, target);
    setText(`#${key}-percent`, percentText);
    $(`#${key}-bar`).style.width = `${pct * 100}%`;
  }

  function renderMealList(meals, date, compact = false) {
    if (!meals.length) {
      return `
        <div class="empty-state">
          <strong>${compact ? "今天还没有饮食记录" : "这一天还没有记录"}</strong>
          <p>拍一张照片，AI 会帮你拆分食物和三大营养素。</p>
          <button class="button button-ghost" type="button" data-open-meal data-meal-date="${date}">记录第一餐</button>
        </div>`;
    }
    return meals.map(meal => {
      const totals = mealTotals(meal);
      const meta = MEAL_META[meal.type] || MEAL_META.snack;
      const title = meal.title || (meal.items || []).map(item => item.name).filter(Boolean).slice(0, 3).join("、") || meta.name;
      const image = meal.images?.[0]
        ? `<img src="${meal.images[0]}" alt="${escapeHtml(meta.name)}照片">`
        : escapeHtml(meta.glyph);
      return `
        <article class="meal-item">
          <div class="meal-thumb">${image}</div>
          <div class="meal-main">
            <strong>${escapeHtml(meta.name)} · ${escapeHtml(title)}</strong>
            <p>${totals.calories} kcal${meal.description ? ` · ${escapeHtml(meal.description)}` : ""}</p>
          </div>
          <div class="meal-macros" aria-label="营养摘要">
            <span class="p">P ${round(totals.protein, 1)}</span>
            <span class="c">C ${round(totals.carbs, 1)}</span>
            <span class="f">F ${round(totals.fat, 1)}</span>
          </div>
          <div class="meal-actions">
            <button class="icon-mini" type="button" data-edit-meal="${meal.id}" title="编辑">✎</button>
            <button class="icon-mini" type="button" data-delete-meal="${meal.id}" title="删除">×</button>
          </div>
        </article>`;
    }).join("");
  }

  function renderMealsView() {
    const selectedDate = state.selectedMealDate || localDateString();
    $("#meal-date-picker").value = selectedDate;
    setText("#meal-date-heading", selectedDate === localDateString() ? "今天" : formatLongDate(selectedDate));
    const meals = dayMeals(selectedDate);
    const totals = dayTotals(selectedDate);
    const targets = getTargets();
    $("#selected-day-meals").innerHTML = renderMealList(meals, selectedDate, false);
    setText("#meal-day-summary", `${meals.length} 餐 · ${totals.calories} kcal`);
    $("#selected-day-totals").innerHTML = `
      <div><span>蛋白质</span><strong>${round(totals.protein, 1)} g</strong></div>
      <div><span>碳水</span><strong>${round(totals.carbs, 1)} g</strong></div>
      <div><span>脂肪</span><strong>${round(totals.fat, 1)} g</strong></div>
      <div><span>热量</span><strong>${totals.calories} kcal</strong></div>`;
    $("#selected-day-bars").innerHTML = [
      ["蛋白", totals.protein, targets.protein, "#ef8b6f"],
      ["碳水", totals.carbs, targets.carbs, "#d9b744"],
      ["脂肪", totals.fat, targets.fat, "#6699ad"]
    ].map(([label, actual, target, color]) => {
      const pct = target ? clamp((actual / target) * 100, 0, 100) : 0;
      return `
        <div class="balance-row">
          <span>${label}</span>
          <div class="progress"><i style="width:${pct}%;background:${color}"></i></div>
          <b>${round(actual, 1)} / ${round(target)} g</b>
        </div>`;
    }).join("");
    $("#day-note").value = state.dayNotes[selectedDate]?.note || "";
  }

  function renderWeightView() {
    const sorted = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
    const latest = currentWeight();
    const goal = num(state.profile.goalWeight);
    const rate = weightRate(sorted);
    const sortedChanges = sorted.length >= 2
      ? latest - num(sorted.at(-2).weight)
      : null;
    setText("#weight-page-current", round(latest, 1));
    setText("#weight-page-goal", round(goal, 1));
    setText("#weight-page-rate", rate === null ? "—" : `${rate > 0 ? "+" : ""}${round(rate, 2)}`);
    setText("#weight-page-modifier", `${state.carbModifier > 0 ? "+" : ""}${state.carbModifier}`);
    setText("#weight-page-delta", sortedChanges === null
      ? "等待第二次固定条件测量"
      : `较上次 ${sortedChanges > 0 ? "+" : ""}${round(sortedChanges, 1)} kg`);
    setText("#weight-page-remaining", latest <= goal
      ? "已经到达设定目标"
      : `还需要减少 ${round(latest - goal, 1)} kg`);

    $("#weight-chart").innerHTML = buildWeightChart(recentWeights(90));
    $("#weight-list").innerHTML = sorted.length
      ? [...sorted].reverse().map((entry, index) => `
          <div class="weight-entry">
            <div>
              <strong>${round(entry.weight, 1)} kg</strong>
              <p>${formatShortDate(entry.date)}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</p>
            </div>
            <button class="icon-mini" type="button" data-delete-weight="${entry.id}" title="删除">×</button>
          </div>`).join("")
      : `<div class="empty-state"><strong>还没有体重记录</strong><p>每周固定时间记录，趋势才有意义。</p><button class="button button-ghost" type="button" data-open-weight>记录当前体重</button></div>`;
  }

  function reportData() {
    const dates = lastWeekDates();
    const days = dates.map(date => {
      const totals = dayTotals(date);
      const meals = dayMeals(date);
      return { date, totals, meals };
    });
    const logged = days.filter(day => day.meals.length);
    const targets = getTargets();
    const averages = logged.length ? logged.reduce((sum, day) => {
      sum.protein += day.totals.protein;
      sum.carbs += day.totals.carbs;
      sum.fat += day.totals.fat;
      sum.calories += day.totals.calories;
      return sum;
    }, { protein: 0, carbs: 0, fat: 0, calories: 0 }) : null;
    if (averages) {
      Object.keys(averages).forEach(key => { averages[key] /= logged.length; });
    }
    let macroAlignment = 0;
    if (logged.length) {
      macroAlignment = logged.reduce((sum, day) => {
        const deviations = [
          targets.protein ? Math.abs(day.totals.protein - targets.protein) / targets.protein : 0,
          targets.carbs ? Math.abs(day.totals.carbs - targets.carbs) / targets.carbs : 0,
          targets.fat ? Math.abs(day.totals.fat - targets.fat) / targets.fat : 0
        ];
        return sum + clamp(1 - deviations.reduce((a, b) => a + b, 0) / 3, 0, 1);
      }, 0) / logged.length;
    }
    const score = Math.round(clamp(logged.length / 7 * 56 + macroAlignment * 44, 0, 100));
    const startWeight = state.weights
      .filter(entry => entry.date >= dates[0] && entry.date <= dates.at(-1))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { dates, days, logged, targets, averages, score, weightEntries: startWeight };
  }

  function renderReport() {
    const report = reportData();
    setText("#report-week-label", `${formatShortDate(report.dates[0])} — ${formatShortDate(report.dates.at(-1))}`);
    setText("#report-score", report.score);
    setText("#report-score-copy", report.score >= 80
      ? "记录和营养结构都很稳定"
      : report.score >= 55
        ? "方向正确，继续提高记录完整度"
        : report.logged.length ? "先把数据记完整，再追求精准" : "完成几次饮食记录后生成");
    setText("#report-score-ring", `${report.score}%`);
    $(".score-ring").style.borderTopColor = report.score >= 70 ? "var(--lime)" : "var(--coral)";
    setText("#report-logged-days", `${report.logged.length} / 7`);
    const change = report.weightEntries.length >= 2
      ? num(report.weightEntries.at(-1).weight) - num(report.weightEntries[0].weight)
      : null;
    setText("#report-weight-change", change === null ? "—" : `${change > 0 ? "+" : ""}${round(change, 1)} kg`);
    setText("#report-avg-calories", report.averages ? `${Math.round(report.averages.calories)} kcal` : "—");
    setText("#report-target-pill", `目标 ${getTargets().calories} kcal`);

    $("#report-macros").innerHTML = ["protein", "carbs", "fat"].map((key, index) => {
      const names = { protein: "蛋白质", carbs: "碳水", fat: "脂肪" };
      const colors = ["#ef8b6f", "#d9b744", "#6699ad"];
      const actual = report.averages ? report.averages[key] : 0;
      const target = report.targets[key];
      const pct = target ? clamp(actual / target * 100, 0, 100) : 0;
      return `
        <div class="report-macro-row">
          <span>${names[key]}</span>
          <div class="progress"><i style="width:${pct}%;background:${colors[index]}"></i></div>
          <b>${report.averages ? round(actual) : "—"} / ${target} g</b>
        </div>`;
    }).join("");

    const insights = buildWeeklyInsights(report);
    $("#report-insights").innerHTML = insights.map((text, index) => `
      <div class="insight"><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(text)}</p></div>
    `).join("");

    $("#weekly-bars").innerHTML = report.days.map(day => {
      const ratio = report.targets.calories ? clamp(day.totals.calories / report.targets.calories, 0, 1.25) : 0;
      const height = clamp(ratio * 100, 2, 100);
      return `
        <div class="day-bar-wrap">
          <div class="day-bar-shell">
            <div class="day-bar" style="--bar-fill:${height}%;${!day.meals.length ? "opacity:.35" : ""}">
              <i></i>
            </div>
          </div>
          <span>${DAY_NAMES[parseLocalDate(day.date).getDay()].replace("周", "")}</span>
        </div>`;
    }).join("");
  }

  function buildWeeklyInsights(report) {
    const insights = [];
    if (!report.logged.length) {
      return ["从今天开始记录至少 4 天，周报才能判断饮食结构和热量趋势。", "本周先建立固定三餐和拍照习惯，不必急着调整目标。"];
    }
    if (report.logged.length < 4) {
      insights.push(`本周只记录了 ${report.logged.length} 天，建议至少记录 4–5 天再判断方案是否有效。`);
    }
    if (report.averages.protein < report.targets.protein * 0.8) {
      insights.push("平均蛋白质偏低。每餐增加一掌心鱼虾、鸡肉或瘦牛肉，优先补足蛋白质。");
    } else if (report.averages.protein > report.targets.protein * 1.2) {
      insights.push("平均蛋白质较高。确认肉类份量，同时保留足够蔬菜和主食。");
    } else {
      insights.push("蛋白质平均摄入接近目标，有利于饱腹感和瘦体重。");
    }
    if (report.averages.fat > report.targets.fat * 1.12) {
      insights.push("脂肪明显偏高。优先检查烹调油、坚果、酱料和红肉，而不是继续削减蛋白质。");
    }
    if (report.averages.carbs < report.targets.carbs * 0.72) {
      insights.push("碳水偏低。若训练掉力或睡眠差，可在训练前后补 20–30 g 主食。");
    }
    if (report.averages.calories > report.targets.calories * 1.12) {
      insights.push("本周平均热量高于目标。下周先减少油脂和主食的隐形份量，不必做极端补偿。");
    } else if (report.averages.calories < report.targets.calories * 0.75) {
      insights.push("平均热量偏低。长期吃太少容易疲劳和反弹，先确认是否漏记或刻意少吃。");
    } else {
      insights.push("本周热量平均接近目标，继续保持当前结构。");
    }
    const rate = report.weightEntries.length >= 2
      ? weightRate(report.weightEntries)
      : null;
    if (rate !== null) {
      if (rate > -0.25) insights.push("本周体重下降较慢。先检查记录准确度；若执行到位，下次可保持或下调 20 g 碳水。");
      else if (rate < -1.2) insights.push("本周下降较快。建议增加 20 g 碳水，并关注训练状态和睡眠。");
      else insights.push(`本周体重变化约 ${round(rate, 2)}%，处于常见参考范围。`);
    }
    return insights.slice(0, 4);
  }

  function buildMiniWeightChart(entries) {
    if (entries.length < 2) {
      return `<svg viewBox="0 0 160 32" preserveAspectRatio="none"><path d="M0 20 C30 20,45 13,70 16 S115 9,160 12" fill="none" stroke="rgba(199,219,114,.55)" stroke-width="2" stroke-dasharray="4 4"/></svg>`;
    }
    const values = entries.map(entry => num(entry.weight));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min || 1;
    const points = values.map((value, index) => {
      const x = index / Math.max(1, values.length - 1) * 160;
      const y = 28 - (value - min) / spread * 22;
      return `${round(x, 1)},${round(y, 1)}`;
    }).join(" ");
    return `<svg viewBox="0 0 160 32" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="#c7db72" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function buildWeightChart(entries) {
    if (!entries.length) {
      return `<div class="chart-empty">记录两次体重后，这里会出现趋势曲线</div>`;
    }
    const width = 900;
    const height = 290;
    const left = 54;
    const right = 24;
    const top = 22;
    const bottom = 42;
    const values = entries.map(entry => num(entry.weight));
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const pad = Math.max(0.4, (rawMax - rawMin) * 0.2);
    const min = rawMin - pad;
    const max = rawMax + pad;
    const span = max - min || 1;
    const point = (entry, index) => {
      const x = entries.length === 1
        ? (left + width - right) / 2
        : left + index / (entries.length - 1) * (width - left - right);
      const y = top + (1 - (num(entry.weight) - min) / span) * (height - top - bottom);
      return { x, y };
    };
    const coordinates = entries.map(point);
    const line = coordinates.map(item => `${round(item.x, 1)},${round(item.y, 1)}`).join(" ");
    const area = [
      `M ${round(coordinates[0].x, 1)} ${height - bottom}`,
      ...coordinates.map(item => `L ${round(item.x, 1)} ${round(item.y, 1)}`),
      `L ${round(coordinates.at(-1).x, 1)} ${height - bottom}`,
      "Z"
    ].join(" ");
    const gridLines = Array.from({ length: 5 }, (_, index) => {
      const y = top + index / 4 * (height - top - bottom);
      const value = max - index / 4 * span;
      return `
        <line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="rgba(31,48,39,.08)" stroke-dasharray="3 6"/>
        <text x="${left - 10}" y="${y + 4}" text-anchor="end" fill="#7d887f" font-size="10">${round(value, 1)}</text>`;
    }).join("");
    const dots = coordinates.map((item, index) => `
      <g>
        <circle cx="${item.x}" cy="${item.y}" r="5" fill="#fffdf8" stroke="#3e735b" stroke-width="2.5"/>
        <title>${formatShortDate(entries[index].date)} · ${round(entries[index].weight, 1)} kg</title>
      </g>`).join("");
    const labels = coordinates.map((item, index) => {
      if (entries.length > 8 && index !== 0 && index !== entries.length - 1 && index % Math.ceil(entries.length / 5) !== 0) return "";
      return `<text x="${item.x}" y="${height - 16}" text-anchor="middle" fill="#7d887f" font-size="10">${formatShortDate(entries[index].date)}</text>`;
    }).join("");
    return `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="体重趋势图">
        <defs>
          <linearGradient id="weightArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#c7db72" stop-opacity=".34"/>
            <stop offset="1" stop-color="#c7db72" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${area}" fill="url(#weightArea)"/>
        <polyline points="${line}" fill="none" stroke="#3e735b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
        ${labels}
      </svg>`;
  }

  function renderAll() {
    renderDashboard();
    renderMealsView();
    renderWeightView();
    renderReport();
  }

  function setActiveView(name) {
    $$(".view").forEach(view => view.classList.toggle("active", view.dataset.view === name));
    $$(".side-nav [data-view-link]").forEach(button => button.classList.toggle("active", button.dataset.viewLink === name));
    $$(".bottom-nav [data-view-link]").forEach(button => button.classList.toggle("active", button.dataset.viewLink === name));
    const titles = {
      dashboard: "今天，也向目标靠近一点",
      meals: "每一餐，都算数",
      weight: "看趋势，不被单日波动带偏",
      report: "复盘一周，调整下一周"
    };
    setText("#page-title", titles[name] || titles.dashboard);
    if (name === "report") renderReport();
    if (name === "weight") renderWeightView();
    if (name === "meals") renderMealsView();
    if (name === "dashboard") renderDashboard();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openDialog(id) {
    const dialog = $(`#${id}`);
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
  }

  function closeDialog(id) {
    const dialog = $(`#${id}`);
    if (dialog?.open) dialog.close();
    if (!$$("dialog[open]").length) document.body.style.overflow = "";
  }

  function emptyDraft() {
    return {
      id: null,
      date: state.selectedMealDate || localDateString(),
      type: inferMealType(),
      description: "",
      title: "",
      images: [],
      items: [],
      aiFeedback: "",
      assumptions: [],
      createdAt: new Date().toISOString()
    };
  }

  function inferMealType() {
    const hour = new Date().getHours();
    if (hour < 10) return "breakfast";
    if (hour < 15) return "lunch";
    if (hour < 21) return "dinner";
    return "snack";
  }

  function openMealDialog(date = null, meal = null) {
    if (meal) {
      draftMeal = JSON.parse(JSON.stringify(meal));
    } else {
      draftMeal = emptyDraft();
      if (date) draftMeal.date = date;
    }
    $("#meal-date").value = draftMeal.date;
    $("#meal-type").value = draftMeal.type;
    $("#meal-description").value = draftMeal.description || "";
    $("#meal-form-message").textContent = "";
    $("#meal-form-message").className = "form-message";
    $("#analysis-editor").hidden = !draftMeal.items.length;
    $("#analysis-state").hidden = true;
    $("#meal-dialog .modal-head h2").textContent = meal ? "编辑这一餐" : "记录一餐";
    renderPhotoPreviews();
    renderDraftItems();
    updateDraftTotals();
    openDialog("meal-dialog");
  }

  function renderPhotoPreviews() {
    $("#photo-previews").innerHTML = draftMeal.images.map((image, index) => `
      <div class="photo-preview">
        <img src="${image}" alt="餐食照片 ${index + 1}">
        <button type="button" data-remove-photo="${index}" aria-label="移除照片">×</button>
      </div>`).join("");
    $("#photo-dropzone").style.display = draftMeal.images.length >= 4 ? "none" : "";
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(file => file.type.startsWith("image/"));
    const remaining = Math.max(0, 4 - draftMeal.images.length);
    if (!files.length) return;
    if (!remaining) {
      showToast("每餐最多上传 4 张照片。");
      return;
    }
    $("#meal-form-message").textContent = "正在压缩照片…";
    for (const file of files.slice(0, remaining)) {
      try {
        draftMeal.images.push(await compressImage(file));
      } catch (error) {
        console.error(error);
      }
    }
    $("#meal-form-message").textContent = "";
    renderPhotoPreviews();
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("图片无法读取"));
        image.onload = () => {
          const maxSide = 1500;
          const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function defaultFoodItem(data = {}) {
    return {
      name: data.name || "",
      portion: data.portion || "",
      protein: round(num(data.protein), 1),
      carbs: round(num(data.carbs), 1),
      fat: round(num(data.fat), 1)
    };
  }

  function renderDraftItems() {
    if (!draftMeal.items.length) {
      $("#analysis-editor").hidden = true;
      return;
    }
    $("#analysis-editor").hidden = false;
    $("#food-items").innerHTML = `
      <div class="food-row food-header" aria-hidden="true">
        <span>食物</span><span>份量</span><span>蛋白 g</span><span>碳水 g</span><span>脂肪 g</span><span></span>
      </div>
      ${draftMeal.items.map((item, index) => `
      <div class="food-row" data-food-index="${index}">
        <input data-field="name" value="${escapeHtml(item.name)}" aria-label="食物名称" placeholder="食物">
        <input data-field="portion" value="${escapeHtml(item.portion)}" aria-label="份量" placeholder="份量">
        <input data-field="protein" type="number" min="0" step="0.1" value="${num(item.protein)}" aria-label="蛋白质克数" placeholder="蛋白">
        <input data-field="carbs" type="number" min="0" step="0.1" value="${num(item.carbs)}" aria-label="碳水克数" placeholder="碳水">
        <input data-field="fat" type="number" min="0" step="0.1" value="${num(item.fat)}" aria-label="脂肪克数" placeholder="脂肪">
        <button type="button" data-remove-food="${index}" aria-label="删除食物">×</button>
      </div>
    `).join("")}`;
    $("#ai-feedback").textContent = draftMeal.aiFeedback ||
      (draftMeal.assumptions?.length ? `估算假设：${draftMeal.assumptions.join("；")}` : "");
    updateDraftTotals();
  }

  function draftTotals() {
    const totals = draftMeal.items.reduce((sum, item) => {
      sum.protein += num(item.protein);
      sum.carbs += num(item.carbs);
      sum.fat += num(item.fat);
      return sum;
    }, { protein: 0, carbs: 0, fat: 0 });
    totals.calories = Math.round(totals.protein * 4 + totals.carbs * 4 + totals.fat * 9);
    return totals;
  }

  function updateDraftTotals() {
    if (!draftMeal) return;
    const totals = draftTotals();
    setText("#draft-protein", `${round(totals.protein, 1)} g`);
    setText("#draft-carbs", `${round(totals.carbs, 1)} g`);
    setText("#draft-fat", `${round(totals.fat, 1)} g`);
    setText("#draft-calories", `${totals.calories} kcal`);
  }

  async function analyzeMeal() {
    if (!draftMeal.images.length && !$("#meal-description").value.trim()) {
      setFormMessage("meal-form-message", "请至少上传一张照片，或描述这餐吃了什么。", true);
      return;
    }
    if (!aiHealth.configured) {
      setFormMessage("meal-form-message", "请先在设置中连接 OpenAI API Key。", true);
      closeDialog("meal-dialog");
      openSettings();
      return;
    }
    const button = $("#analyze-meal");
    button.disabled = true;
    $("#analysis-state").hidden = false;
    $("#analysis-state-title").textContent = "正在识别餐盘";
    $("#analysis-state-copy").textContent = "拆分食物、估算份量并计算蛋白质、碳水和脂肪……";
    setFormMessage("meal-form-message", "");
    try {
      const mealPayload = {
        images: draftMeal.images,
        description: $("#meal-description").value.trim(),
        mealType: $("#meal-type").value,
        targets: getTargets()
      };
      let payload;
      if (aiMode === "direct") {
        payload = await analyzeMealDirect(mealPayload);
      }
      else if (aiMode === "proxy") {
        payload = await analyzeMealProxy(mealPayload);
      }
      else {
        payload = await analyzeMealLocal(mealPayload);
      }
      const result = normalizeAnalysis(payload);
      draftMeal.items = result.items;
      draftMeal.title = result.mealName;
      draftMeal.aiFeedback = result.coachFeedback;
      draftMeal.assumptions = result.assumptions;
      renderDraftItems();
      $("#analysis-state-title").textContent = "识别完成";
      $("#analysis-state-copy").textContent = "结果可以根据实际份量继续修改。";
      setTimeout(() => { $("#analysis-state").hidden = true; }, 700);
      $("#save-meal").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      console.error(error);
      $("#analysis-state").hidden = true;
      setFormMessage("meal-form-message", error.message || "识别失败，请稍后重试。", true);
    } finally {
      button.disabled = false;
    }
  }

  async function analyzeMealLocal(mealPayload) {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mealPayload)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `识别失败（HTTP ${response.status}）`);
    return payload;
  }

  async function analyzeMealProxy(mealPayload) {
    const proxyUrl = (state.settings.proxyUrl || "").trim();
    if (!proxyUrl) throw new Error("请先填写 AI 代理地址。");
    const proxyToken = localStorage.getItem(PROXY_TOKEN_KEY) || "";
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(proxyToken ? { "X-App-Token": proxyToken } : {})
      },
      body: JSON.stringify(mealPayload)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `代理识别失败（HTTP ${response.status}）`);
    return payload;
  }

  async function analyzeMealDirect(mealPayload) {
    const apiKey = localStorage.getItem(DIRECT_AI_KEY) || "";
    if (!apiKey) throw new Error("请先在设置中填写 OpenAI API Key。");
    const model = state.settings.model || "gpt-4.1-mini";
    const baseUrl = (state.settings.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const mealTypeName = MEAL_META[mealPayload.mealType]?.name || "加餐";
    const target = mealPayload.targets;
    const targetText = target
      ? `当前每日目标：蛋白质 ${target.protein} g，碳水 ${target.carbs} g，脂肪 ${target.fat} g，热量约 ${target.calories} kcal。`
      : "当前没有额外每日目标。";
    const systemPrompt = [
      "你是一名严谨、务实的中文营养记录助手。用户会提供餐食照片和可选说明。",
      "请拆分照片中可见或被文字明确描述的食物，估算本餐实际食用份量，并计算蛋白质、碳水、脂肪和热量。",
      "不要凭空添加食物；看不清重量时给合理中位估算，并在 assumptions 中写明。",
      "调味油、酱汁、坚果和饮品等隐形热量也要纳入。",
      "所有营养素必须是本餐实际摄入总量，单位克，不能写每100克数值。",
      "多张照片先去重同一盘食物。confidence 用 0 到 1 表示。",
      "coach_feedback 用一两句话指出最值得注意的一点，不做疾病诊断。",
      "只返回符合指定 JSON Schema 的数据，不要 Markdown。"
    ].join("\n");
    const userText = `本餐类型：${mealTypeName}\n用户描述：${mealPayload.description || "无"}\n${targetText}\n请按食物拆分并输出本餐实际摄入量。`;
    const content = [{ type: "input_text", text: userText }];
    mealPayload.images.forEach(image => content.push({ type: "input_image", image_url: image }));
    const itemSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        portion: { type: "string" },
        protein: { type: "number", minimum: 0 },
        carbs: { type: "number", minimum: 0 },
        fat: { type: "number", minimum: 0 },
        calories: { type: "number", minimum: 0 },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["name", "portion", "protein", "carbs", "fat", "calories", "confidence"]
    };
    const totalSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        protein: { type: "number", minimum: 0 },
        carbs: { type: "number", minimum: 0 },
        fat: { type: "number", minimum: 0 },
        calories: { type: "number", minimum: 0 }
      },
      required: ["protein", "carbs", "fat", "calories"]
    };
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        meal_name: { type: "string" },
        items: { type: "array", items: itemSchema },
        totals: totalSchema,
        assumptions: { type: "array", items: { type: "string" } },
        coach_feedback: { type: "string" }
      },
      required: ["meal_name", "items", "totals", "assumptions", "coach_feedback"]
    };
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "meal_nutrition_analysis",
            strict: true,
            schema
          }
        },
        max_output_tokens: 1800
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.message || `OpenAI 请求失败（HTTP ${response.status}）`);
    }
    const text = (payload.output || [])
      .flatMap(output => output.content || [])
      .filter(contentItem => contentItem.type === "output_text" && contentItem.text)
      .map(contentItem => contentItem.text)
      .join("\n")
      .trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
    if (!text) throw new Error("AI 没有返回可解析的识别结果。");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("AI 返回的结果不是有效 JSON，请重试。");
    }
  }

  function normalizeAnalysis(payload) {
    const items = Array.isArray(payload.items) ? payload.items : [];
    const normalizedItems = items.length
      ? items.map(item => defaultFoodItem(item))
      : [{ name: "整餐估算", portion: "1 份", protein: num(payload.totals?.protein), carbs: num(payload.totals?.carbs), fat: num(payload.totals?.fat) }];
    return {
      mealName: String(payload.meal_name || "AI 识别餐食").slice(0, 80),
      items: normalizedItems,
      coachFeedback: String(payload.coach_feedback || payload.notes || "营养结果为照片估算，请根据实际份量修改。"),
      assumptions: Array.isArray(payload.assumptions) ? payload.assumptions.map(String).slice(0, 5) : []
    };
  }

  function setFormMessage(elementId, text, isError = false, isSuccess = false) {
    const element = $(`#${elementId}`);
    if (!element) return;
    element.textContent = text;
    element.className = `form-message${isError ? " error" : ""}${isSuccess ? " success" : ""}`;
  }

  function manualMealEntry() {
    if (!draftMeal.items.length) {
      draftMeal.items = [defaultFoodItem()];
      renderDraftItems();
    }
    $("#analysis-editor").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => $("#food-items input")?.focus(), 250);
  }

  async function saveDraftMeal(event) {
    event.preventDefault();
    if (!draftMeal) return;
    draftMeal.date = $("#meal-date").value || localDateString();
    draftMeal.type = $("#meal-type").value;
    draftMeal.description = $("#meal-description").value.trim();
    draftMeal.items = draftMeal.items.filter(item =>
      item.name.trim() || num(item.protein) || num(item.carbs) || num(item.fat)
    );
    if (!draftMeal.items.length) {
      setFormMessage("meal-form-message", "至少填写一种食物及其营养数据。", true);
      return;
    }
    if (!draftMeal.title) {
      draftMeal.title = draftMeal.items.map(item => item.name).filter(Boolean).slice(0, 3).join("、") || MEAL_META[draftMeal.type].name;
    }
    const existingIndex = state.meals.findIndex(meal => meal.id === draftMeal.id);
    const mealToSave = { ...draftMeal, updatedAt: new Date().toISOString() };
    if (existingIndex >= 0) state.meals[existingIndex] = mealToSave;
    else state.meals.push(mealToSave);
    state.selectedMealDate = mealToSave.date;
    saveState();
    closeDialog("meal-dialog");
    renderAll();
    showToast(existingIndex >= 0 ? "这一餐已更新。" : "这一餐已记入今天的饮食。");
  }

  function deleteMeal(id) {
    const meal = state.meals.find(item => item.id === id);
    if (!meal) return;
    if (!confirm(`删除“${MEAL_META[meal.type]?.name || "这一餐"} · ${meal.title || "饮食记录"}”？`)) return;
    state.meals = state.meals.filter(item => item.id !== id);
    saveState();
    renderAll();
    showToast("饮食记录已删除。");
  }

  function openWeightDialog() {
    $("#weight-date").value = localDateString();
    $("#weight-value").value = round(currentWeight(), 1);
    $("#weight-note").value = "";
    setFormMessage("weight-form-message", "");
    openDialog("weight-dialog");
  }

  async function saveWeight(event) {
    event.preventDefault();
    const date = $("#weight-date").value;
    const weight = num($("#weight-value").value);
    const note = $("#weight-note").value.trim();
    if (!date || weight < 25 || weight > 300) {
      setFormMessage("weight-form-message", "请输入有效日期和体重。", true);
      return;
    }

    const previous = [...state.weights]
      .filter(entry => entry.date < date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    const existing = state.weights.find(entry => entry.date === date);
    if (existing) {
      existing.weight = weight;
      existing.note = note;
      existing.updatedAt = new Date().toISOString();
    } else {
      state.weights.push({
        id: uid(),
        date,
        weight,
        note,
        createdAt: new Date().toISOString()
      });
    }
    state.profile.weight = weight;
    const adjustment = evaluateWeightAdjustment(previous, { date, weight });
    saveState();
    closeDialog("weight-dialog");
    renderAll();
    if (adjustment) {
      showToast(adjustment);
    } else {
      showToast("体重已保存，每日目标已按新体重更新。");
    }
  }

  function evaluateWeightAdjustment(previous, current) {
    if (!previous) return "";
    const elapsed = daysBetween(previous.date, current.date);
    if (elapsed < 5 || elapsed > 35) return "";
    if (state.lastAutoAdjustDate && daysBetween(state.lastAutoAdjustDate, current.date) < 7) {
      return "体重已保存；距离上次自动调整不足 7 天，今天先不叠加修改。";
    }
    const weeklyRate = ((num(current.weight) - num(previous.weight)) / num(previous.weight)) * (7 / elapsed) * 100;
    const adherence = loggedDaysInRange(lastWeekDates(current.date));
    let nextModifier = num(state.carbModifier);
    let message = "";
    if (weeklyRate > -0.25 && adherence >= 4) {
      nextModifier = Math.max(-80, nextModifier - 20);
      message = `近 ${elapsed} 天下降偏慢，已自动下调 20 g 碳水。`;
    } else if (weeklyRate < -1.2) {
      nextModifier = Math.min(40, nextModifier + 20);
      message = `近 ${elapsed} 天下降较快，已自动回升 20 g 碳水。`;
    } else if (weeklyRate > 0.55) {
      nextModifier = Math.max(-80, nextModifier - 20);
      message = "近期体重上升，已自动下调 20 g 碳水；先确认记录是否完整。";
    }
    if (message) {
      state.carbModifier = nextModifier;
      state.lastAutoAdjustDate = current.date;
      return `${message}现在每天碳水修正 ${nextModifier > 0 ? "+" : ""}${nextModifier} g。`;
    }
    return "";
  }

  function deleteWeight(id) {
    const entry = state.weights.find(item => item.id === id);
    if (!entry || !confirm(`删除 ${formatShortDate(entry.date)} 的 ${round(entry.weight, 1)} kg 记录？`)) return;
    state.weights = state.weights.filter(item => item.id !== id);
    const sorted = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
    state.profile.weight = sorted.length ? num(sorted.at(-1).weight) : state.profile.weight;
    saveState();
    renderAll();
    showToast("体重记录已删除。");
  }

  function openSettings() {
    populateSettings();
    openDialog("settings-dialog");
  }

  function selectedAiMode() {
    return $('input[name="ai-connection-mode"]:checked')?.value || "direct";
  }

  function updateAiModePanels(mode = selectedAiMode()) {
    $("#direct-ai-panel").hidden = mode !== "direct";
    $("#proxy-ai-panel").hidden = mode !== "proxy";
    $$(".backend-only").forEach(element => {
      element.style.display = backendAvailable ? "" : "none";
    });
  }

  function populateSettings() {
    $("#profile-name").value = state.profile.name || "";
    $("#profile-sex").value = state.profile.sex || "female";
    $("#profile-height").value = num(state.profile.height);
    $("#profile-weight").value = round(currentWeight(), 1);
    $("#profile-goal-weight").value = num(state.profile.goalWeight);
    $("#profile-exercise").value = num(state.profile.weeklyExerciseHours);
    $("#profile-female-support").checked = Boolean(state.profile.femaleSupport);
    $("#openai-model").value = state.settings.model || "gpt-4.1-mini";
    $("#openai-base-url").value = state.settings.baseUrl || "https://api.openai.com/v1";
    $("#ai-proxy-url").value = state.settings.proxyUrl || "";
    $("#ai-proxy-token").value = localStorage.getItem(PROXY_TOKEN_KEY) || "";
    $("#openai-key").value = "";
    const preferred = state.settings.connectionMode || "auto";
    const resolvedMode = preferred === "auto"
      ? (backendAvailable ? "backend" : (localStorage.getItem(DIRECT_AI_KEY) ? "direct" : "direct"))
      : preferred;
    const safeMode = resolvedMode === "backend" && !backendAvailable ? "direct" : resolvedMode;
    const modeInput = $(`input[name="ai-connection-mode"][value="${safeMode}"]`);
    if (modeInput) modeInput.checked = true;
    updateAiModePanels(safeMode);
    updateAiStatus();
    setFormMessage("settings-message", "");
  }

  function saveSettings(event) {
    event.preventDefault();
    const newWeight = num($("#profile-weight").value, currentWeight());
    state.profile = {
      ...state.profile,
      name: $("#profile-name").value.trim() || "我的减脂计划",
      sex: $("#profile-sex").value,
      height: num($("#profile-height").value, state.profile.height),
      weight: newWeight,
      goalWeight: num($("#profile-goal-weight").value, state.profile.goalWeight),
      weeklyExerciseHours: clamp(num($("#profile-exercise").value, state.profile.weeklyExerciseHours), 0, 40),
      femaleSupport: $("#profile-female-support").checked
    };
    state.settings = {
      ...state.settings,
      model: $("#openai-model").value.trim() || "gpt-4.1-mini",
      baseUrl: $("#openai-base-url").value.trim().replace(/\/+$/, "") || "https://api.openai.com/v1"
    };
    const latestWeight = [...state.weights].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (!latestWeight || latestWeight.date !== localDateString()) {
      state.weights.push({
        id: uid(),
        date: localDateString(),
        weight: newWeight,
        note: "来自身体资料更新",
        createdAt: new Date().toISOString()
      });
    } else {
      latestWeight.weight = newWeight;
    }
    saveState();
    closeDialog("settings-dialog");
    renderAll();
    showToast("身体资料已保存，目标已重新计算。");
  }

  async function checkAiHealth() {
    let backendPayload = null;
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const contentType = response.headers.get("content-type") || "";
      if (response.ok && contentType.includes("application/json")) {
        backendPayload = await response.json();
        backendAvailable = true;
      }
    } catch (error) {
      backendAvailable = false;
    }

    const directKey = localStorage.getItem(DIRECT_AI_KEY) || "";
    const proxyUrl = (state.settings.proxyUrl || "").trim();
    const preferred = state.settings.connectionMode || "auto";
    let mode = preferred;
    if (preferred === "auto") {
      if (directKey) mode = "direct";
      else if (proxyUrl) mode = "proxy";
      else if (backendAvailable) mode = "backend";
      else mode = "direct";
    }
    if (mode === "backend" && !backendAvailable) mode = directKey ? "direct" : "proxy";
    if (mode === "proxy" && !proxyUrl) mode = directKey ? "direct" : "direct";
    aiMode = mode;
    if (mode === "direct") {
      aiHealth = {
        configured: Boolean(directKey),
        model: state.settings.model || "gpt-4.1-mini",
        mode
      };
    }
    else if (mode === "proxy") {
      aiHealth = {
        configured: Boolean(proxyUrl),
        model: state.settings.model || "gpt-4.1-mini",
        mode
      };
    }
    else {
      aiHealth = {
        configured: Boolean(backendPayload?.configured),
        model: backendPayload?.model || state.settings.model,
        mode
      };
    }
    updateAiStatus();
  }

  function updateAiStatus() {
    const connected = Boolean(aiHealth.configured);
    const modeLabels = {
      direct: "设备直连",
      proxy: "安全代理",
      backend: "本机服务"
    };
    $("#ai-status-dot").classList.toggle("connected", connected);
    $("#settings-ai-status").textContent = connected
      ? `${modeLabels[aiHealth.mode] || "已连接"} · ${aiHealth.model || state.settings.model}`
      : "尚未配置";
    $("#settings-ai-status").classList.toggle("connected", connected);
    if (connected) {
      $("#ai-hint").textContent = aiHealth.mode === "proxy"
        ? "照片将通过你的安全代理完成识别。"
        : `将使用 ${aiHealth.model || state.settings.model} 进行照片估算。`;
    }
    else {
      $("#ai-hint").textContent = "图片只用于本次营养估算，可随时在设置中关闭 AI。";
    }
  }

  async function saveAiConfig() {
    const key = $("#openai-key").value.trim();
    const model = $("#openai-model").value.trim() || "gpt-4.1-mini";
    const baseUrl = $("#openai-base-url").value.trim().replace(/\/+$/, "") || "https://api.openai.com/v1";
    const proxyUrl = $("#ai-proxy-url").value.trim();
    const mode = selectedAiMode();
    const button = $("#save-ai-config");
    button.disabled = true;
    setFormMessage("ai-config-message", "正在保存并测试连接…");
    try {
      if (mode === "direct") {
        const effectiveKey = key || localStorage.getItem(DIRECT_AI_KEY) || "";
        if (!effectiveKey) throw new Error("请填写 OpenAI API Key。");
        const testResponse = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${effectiveKey}` },
          cache: "no-store"
        });
        if (!testResponse.ok) {
          const errorPayload = await testResponse.json().catch(() => ({}));
          throw new Error(errorPayload.error?.message || `设备直连测试失败（HTTP ${testResponse.status}）`);
        }
        localStorage.setItem(DIRECT_AI_KEY, effectiveKey);
      }
      else if (mode === "proxy") {
        if (!proxyUrl) throw new Error("请填写 AI 代理地址。");
        const testUrl = new URL(proxyUrl, location.href);
        if (!["https:", "http:"].includes(testUrl.protocol)) throw new Error("代理地址格式不正确。");
        const proxyToken = $("#ai-proxy-token").value.trim();
        const testResponse = await fetch(testUrl.href, {
          cache: "no-store",
          headers: proxyToken ? { "X-App-Token": proxyToken } : {}
        });
        if (!testResponse.ok) throw new Error(`代理连接测试失败（HTTP ${testResponse.status}）`);
        if (proxyToken) localStorage.setItem(PROXY_TOKEN_KEY, proxyToken);
        else localStorage.removeItem(PROXY_TOKEN_KEY);
      }
      else {
        const saveResponse = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: key, model, baseUrl })
        });
        const savePayload = await saveResponse.json().catch(() => ({}));
        if (!saveResponse.ok) throw new Error(savePayload.error || "配置保存失败");
        const testResponse = await fetch("/api/test", { method: "POST" });
        const testPayload = await testResponse.json().catch(() => ({}));
        if (!testResponse.ok) throw new Error(testPayload.error || "AI 连接测试失败");
      }
      state.settings.model = model;
      state.settings.baseUrl = baseUrl;
      state.settings.connectionMode = mode;
      state.settings.proxyUrl = proxyUrl;
      saveState();
      $("#openai-key").value = "";
      await checkAiHealth();
      setFormMessage("ai-config-message", `${mode === "proxy" ? "代理" : mode === "backend" ? "本机服务" : "设备直连"}连接成功。现在可以拍照识别每餐。`, false, true);
    } catch (error) {
      setFormMessage("ai-config-message", error.message || "连接失败，请检查 Key、模型和网络。", true);
    } finally {
      button.disabled = false;
    }
  }

  async function clearAiConfig() {
    if (!confirm("移除当前设备保存的 AI 配置？照片识别将暂不可用。")) return;
    try {
      localStorage.removeItem(DIRECT_AI_KEY);
      localStorage.removeItem(PROXY_TOKEN_KEY);
      if (backendAvailable) {
        await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ removeApiKey: true, model: state.settings.model, baseUrl: state.settings.baseUrl })
        });
      }
      state.settings.proxyUrl = "";
      state.settings.connectionMode = backendAvailable ? "backend" : "direct";
      saveState();
      await checkAiHealth();
      $("#ai-proxy-url").value = "";
      $("#ai-proxy-token").value = "";
      setFormMessage("ai-config-message", "已移除当前设备上的 AI 配置。", false, true);
    } catch (error) {
      setFormMessage("ai-config-message", error.message, true);
    }
  }

  function resetCarbModifier() {
    state.carbModifier = 0;
    state.lastAutoAdjustDate = null;
    saveState();
    renderAll();
    showToast("已恢复为视频原始计算基线，不再叠加智能碳水修正。");
  }

  function exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "轻脂航海图",
      version: 1,
      data: state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `轻脂航海图-备份-${localDateString()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    showToast("备份文件已导出。");
  }

  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => showToast("备份文件读取失败。", true);
    reader.onload = async () => {
      try {
        const payload = JSON.parse(reader.result);
        const imported = payload.data || payload;
        if (!imported.profile || !Array.isArray(imported.meals) || !Array.isArray(imported.weights)) {
          throw new Error("文件不是有效的轻脂航海图备份");
        }
        if (!confirm("导入会覆盖当前浏览器中的全部记录，是否继续？")) return;
        state = hydrateState(imported);
        await writeStoredState(state);
        populateSettings();
        renderAll();
        closeDialog("settings-dialog");
        showToast("备份已导入。");
      } catch (error) {
        setFormMessage("settings-message", error.message || "导入失败。", true);
      }
    };
    reader.readAsText(file);
  }

  async function resetAllData() {
    if (!confirm("确认清空全部饮食、照片、体重和设置？此操作无法撤销。")) return;
    state = defaultState();
    await writeStoredState(state);
    populateSettings();
    renderAll();
    closeDialog("settings-dialog");
    showToast("全部本地数据已清空。");
  }

  function saveDayNote() {
    const date = state.selectedMealDate || localDateString();
    state.dayNotes[date] = {
      note: $("#day-note").value.trim(),
      updatedAt: new Date().toISOString()
    };
    saveState();
    showToast("今日备注已保存。");
  }

  function bindEvents() {
    document.addEventListener("click", event => {
      const nav = event.target.closest("[data-view-link]");
      if (nav) {
        event.preventDefault();
        setActiveView(nav.dataset.viewLink);
        return;
      }
      const mealButton = event.target.closest("[data-open-meal]");
      if (mealButton) {
        openMealDialog(mealButton.dataset.mealDate || state.selectedMealDate || localDateString());
        return;
      }
      if (event.target.closest("[data-open-weight]")) {
        openWeightDialog();
        return;
      }
      if (event.target.closest("[data-open-settings]")) {
        openSettings();
        return;
      }
      const closeButton = event.target.closest("[data-close-dialog]");
      if (closeButton) {
        closeDialog(closeButton.dataset.closeDialog);
        return;
      }
      const editMeal = event.target.closest("[data-edit-meal]");
      if (editMeal) {
        const meal = state.meals.find(item => item.id === editMeal.dataset.editMeal);
        if (meal) openMealDialog(meal.date, meal);
        return;
      }
      const deleteMealButton = event.target.closest("[data-delete-meal]");
      if (deleteMealButton) {
        deleteMeal(deleteMealButton.dataset.deleteMeal);
        return;
      }
      const deleteWeightButton = event.target.closest("[data-delete-weight]");
      if (deleteWeightButton) {
        deleteWeight(deleteWeightButton.dataset.deleteWeight);
        return;
      }
      const removePhoto = event.target.closest("[data-remove-photo]");
      if (removePhoto) {
        draftMeal.images.splice(Number(removePhoto.dataset.removePhoto), 1);
        renderPhotoPreviews();
        return;
      }
      const removeFood = event.target.closest("[data-remove-food]");
      if (removeFood) {
        draftMeal.items.splice(Number(removeFood.dataset.removeFood), 1);
        renderDraftItems();
      }
    });

    $("#choose-meal-photos").addEventListener("click", () => $("#meal-photos").click());
    $("#choose-meal-camera").addEventListener("click", () => $("#meal-camera-input").click());
    $("#meal-photos").addEventListener("change", event => {
      handleFiles(event.target.files);
      event.target.value = "";
    });
    $("#meal-camera-input").addEventListener("change", event => {
      handleFiles(event.target.files);
      event.target.value = "";
    });

    const dropzone = $("#photo-dropzone");
    ["dragenter", "dragover"].forEach(name => dropzone.addEventListener(name, event => {
      event.preventDefault();
      dropzone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach(name => dropzone.addEventListener(name, event => {
      event.preventDefault();
      dropzone.classList.remove("dragging");
    }));
    dropzone.addEventListener("drop", event => handleFiles(event.dataTransfer.files));

    $("#analyze-meal").addEventListener("click", analyzeMeal);
    $("#manual-meal").addEventListener("click", manualMealEntry);
    $("#meal-form").addEventListener("submit", saveDraftMeal);
    $("#weight-form").addEventListener("submit", saveWeight);
    $("#settings-form").addEventListener("submit", saveSettings);

    $("#food-items").addEventListener("input", event => {
      const row = event.target.closest("[data-food-index]");
      if (!row || !draftMeal) return;
      const index = Number(row.dataset.foodIndex);
      const field = event.target.dataset.field;
      if (!field || !draftMeal.items[index]) return;
      draftMeal.items[index][field] = field === "name" || field === "portion"
        ? event.target.value
        : num(event.target.value);
      updateDraftTotals();
    });
    $("#add-food-row").addEventListener("click", () => {
      draftMeal.items.push(defaultFoodItem());
      renderDraftItems();
    });

    $("#meal-date-picker").addEventListener("change", event => {
      state.selectedMealDate = event.target.value;
      saveState();
      renderMealsView();
    });
    $("#meal-date-prev").addEventListener("click", () => {
      state.selectedMealDate = addDays(state.selectedMealDate || localDateString(), -1);
      saveState();
      renderMealsView();
    });
    $("#meal-date-next").addEventListener("click", () => {
      state.selectedMealDate = addDays(state.selectedMealDate || localDateString(), 1);
      saveState();
      renderMealsView();
    });
    $("#meal-date-today").addEventListener("click", () => {
      state.selectedMealDate = localDateString();
      saveState();
      renderMealsView();
    });
    $("#save-day-note").addEventListener("click", saveDayNote);
    $("#reset-carb-modifier").addEventListener("click", resetCarbModifier);
    $("#save-ai-config").addEventListener("click", saveAiConfig);
    $("#clear-ai-config").addEventListener("click", clearAiConfig);
    $$('input[name="ai-connection-mode"]').forEach(input => {
      input.addEventListener("change", () => {
        updateAiModePanels(input.value);
        setFormMessage("ai-config-message", "");
      });
    });
    $("#toggle-key-visibility").addEventListener("click", () => {
      const input = $("#openai-key");
      input.type = input.type === "password" ? "text" : "password";
      $("#toggle-key-visibility").textContent = input.type === "password" ? "显示" : "隐藏";
    });
    $("#export-data").addEventListener("click", exportData);
    $("#import-data").addEventListener("click", () => $("#import-file").click());
    $("#import-file").addEventListener("change", event => {
      importData(event.target.files?.[0]);
      event.target.value = "";
    });
    $("#reset-all-data").addEventListener("click", resetAllData);

    $$("dialog").forEach(dialog => {
      dialog.addEventListener("cancel", () => {
        setTimeout(() => {
          if (!$$("dialog[open]").length) document.body.style.overflow = "";
        }, 0);
      });
      dialog.addEventListener("click", event => {
        if (event.target === dialog) closeDialog(dialog.id);
      });
    });

    window.addEventListener("online", () => showToast("网络连接已恢复。"));
    window.addEventListener("offline", () => showToast("当前离线，已有记录仍可继续编辑。"));
  }

  async function initialize() {
    try {
      const stored = await readStoredState();
      state = hydrateState(stored);
      if (!state.weights.length && num(state.profile.weight)) {
        state.weights.push({
          id: uid(),
          date: state.profile.startDate || localDateString(),
          weight: num(state.profile.weight),
          note: "初始体重",
          createdAt: new Date().toISOString()
        });
        await writeStoredState(state);
      }
    } catch (error) {
      console.error(error);
      state = defaultState();
    }
    bindEvents();
    renderAll();
    await checkAiHealth();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  initialize();
})();
