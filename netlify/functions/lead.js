const https = require("https");
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  let d; try { d = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { statusCode: 400, body: "Invalid JSON" };
  for (const k of ["name","country","program","level","contact"]) if (!String(d[k] || "").trim()) return { statusCode: 400, body: "Missing required field" };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map(x=>x.trim()).filter(Boolean);
  if (!token || !chats.length) return { statusCode: 503, body: "Telegram integration is not configured" };
  const safe = v => String(v || "—").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])).slice(0,1000);
  const text = ["📩 <b>Новая заявка DEIKIN</b>","",`<b>Имя:</b> ${safe(d.name)}`,`<b>Страна:</b> ${safe(d.country)}`,`<b>Программа:</b> ${safe(d.program)}`,`<b>Образование:</b> ${safe(d.level)}`,`<b>Контакт:</b> ${safe(d.contact)}`,`<b>Язык:</b> ${safe(d.language)}`,`<b>Комментарий:</b> ${safe(d.message)}`].join("\n");
  const send = chat_id => new Promise((resolve,reject)=>{const body=JSON.stringify({chat_id,text,parse_mode:"HTML"});const req=https.request({hostname:"api.telegram.org",path:`/bot${token}/sendMessage`,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{let raw="";res.on("data",c=>raw+=c);res.on("end",()=>{try{const x=JSON.parse(raw);if(res.statusCode<300&&x.ok)resolve(x);else reject(new Error(x.description||"Telegram error"));}catch(e){reject(e);}});});req.on("error",reject);req.write(body);req.end();});
  try { await Promise.all(chats.map(send)); return { statusCode: 200, headers:{"Content-Type":"application/json"}, body: JSON.stringify({ok:true}) }; }
  catch { return { statusCode: 502, body: "Telegram delivery failed" }; }
};
