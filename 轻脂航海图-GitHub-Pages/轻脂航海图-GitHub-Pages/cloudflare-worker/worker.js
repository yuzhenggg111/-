const SYSTEM_PROMPT = `你是一名严谨、务实的中文营养记录助手。用户会提供餐食照片和可选说明。请拆分照片中可见或被文字明确描述的食物，估算本餐实际食用份量，并计算蛋白质、碳水、脂肪和热量。
不要凭空添加食物；看不清重量时给合理中位估算，并在 assumptions 中写明。
调味油、酱汁、坚果和饮品等隐形热量也要纳入。
所有营养素必须是本餐实际摄入总量，单位克，不能写每100克数值。
多张照片先去重同一盘食物。confidence 用 0 到 1 表示。
coach_feedback 用一两句话指出最值得注意的一点，不做疾病诊断。
只返回符合指定 JSON Schema 的数据，不要 Markdown。`;

const MEAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    meal_name: { type: "string" },
    items: {
      type: "array",
      items: {
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
      }
    },
    totals: {
      type: "object",
      additionalProperties: false,
      properties: {
        protein: { type: "number", minimum: 0 },
        carbs: { type: "number", minimum: 0 },
        fat: { type: "number", minimum: 0 },
        calories: { type: "number", minimum: 0 }
      },
      required: ["protein", "carbs", "fat", "calories"]
    },
    assumptions: {
      type: "array",
      items: { type: "string" }
    },
    coach_feedback: { type: "string" }
  },
  required: ["meal_name", "items", "totals", "assumptions", "coach_feedback"]
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : (origin === allowed ? origin : "null"),
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function unauthorizedToken(request, env) {
  return Boolean(env.PROXY_TOKEN) && request.headers.get("X-App-Token") !== env.PROXY_TOKEN;
}

function allowedOrigin(request, env) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  return allowed === "*" || request.headers.get("Origin") === allowed;
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (!allowedOrigin(request, env)) {
      return json({ error: "Origin not allowed" }, 403, headers);
    }

    if (unauthorizedToken(request, env)) {
      return json({ error: "Unauthorized proxy token" }, 401, headers);
    }

    if (request.method === "GET") {
      return json({
        ok: true,
        configured: Boolean(env.OPENAI_API_KEY),
        model: env.OPENAI_MODEL || "gpt-4.1-mini"
      }, 200, headers);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, headers);
    }

    if (!env.OPENAI_API_KEY) {
      return json({ error: "OPENAI_API_KEY is not configured on the Worker" }, 500, headers);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > 24_000_000) {
      return json({ error: "图片过大，请最多上传 4 张压缩照片" }, 413, headers);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, headers);
    }

    const images = Array.isArray(payload.images) ? payload.images : [];
    const description = String(payload.description || "").trim();
    if (!images.length && !description) {
      return json({ error: "请至少上传一张照片或填写食物描述" }, 400, headers);
    }
    if (images.length > 4) {
      return json({ error: "每餐最多支持 4 张照片" }, 400, headers);
    }
    if (images.some(image => !/^data:image\/(jpeg|png|webp);base64,/.test(String(image)))) {
      return json({ error: "照片格式无效" }, 400, headers);
    }

    const mealTypes = {
      breakfast: "早餐",
      lunch: "午餐",
      dinner: "晚餐",
      snack: "加餐"
    };
    const mealType = mealTypes[payload.mealType] || "加餐";
    const target = payload.targets;
    const targetText = target
      ? `当前每日目标：蛋白质 ${target.protein} g，碳水 ${target.carbs} g，脂肪 ${target.fat} g，热量约 ${target.calories} kcal。`
      : "当前没有额外每日目标。";
    const userText = `本餐类型：${mealType}\n用户描述：${description || "无"}\n${targetText}\n请按食物拆分并输出本餐实际摄入量。`;
    const content = [{ type: "input_text", text: userText }];
    images.forEach(image => content.push({ type: "input_image", image_url: image }));

    const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = env.OPENAI_MODEL || "gpt-4.1-mini";
    const openaiResponse = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: SYSTEM_PROMPT }]
          },
          { role: "user", content }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "meal_nutrition_analysis",
            strict: true,
            schema: MEAL_SCHEMA
          }
        },
        max_output_tokens: 1800
      })
    });

    const data = await openaiResponse.json().catch(() => ({}));
    if (!openaiResponse.ok) {
      return json({
        error: data.error?.message || `OpenAI request failed (${openaiResponse.status})`
      }, 502, headers);
    }

    const text = (data.output || [])
      .flatMap(output => output.content || [])
      .filter(item => item.type === "output_text" && item.text)
      .map(item => item.text)
      .join("\n")
      .trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");

    if (!text) {
      return json({ error: "AI returned no parseable output" }, 502, headers);
    }

    try {
      return json(JSON.parse(text), 200, headers);
    } catch {
      return json({ error: "AI returned invalid JSON" }, 502, headers);
    }
  }
};
