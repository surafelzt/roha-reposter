// Reply templates (English / Amharic) and AI prompts for the answer bot.
// The owner will check the Amharic text.

export const GREETING = {
  en: "Hello! Welcome to ROHA Tools 🔧\nSend us the name or a photo of the item you need, and we'll tell you the price.",
  am: "ሰላም! ወደ ROHA Tools እንኳን በደህና መጡ 🔧\nየሚፈልጉትን ዕቃ ስም ወይም ፎቶ ይላኩልን፣ ዋጋውን እንነግርዎታለን።",
};

export const FOUND_HEAD = {
  text: { en: "Here's what we have:", am: 'ያሉን ዕቃዎች፦' },
  photo: { en: 'Is it one of these?', am: 'ከእነዚህ አንዱ ነው?' },
};

// {name} must already be HTML-escaped, {price} already formatted with commas.
export const LINE = {
  en: '• <b>{name}</b> — {price} ETB',
  am: '• <b>{name}</b> — {price} ብር',
};

export const FOOTER = {
  en: 'To order, reply here or call {phone_display} 📞',
  am: 'ለማዘዝ እዚሁ ይጻፉልን ወይም በ{phone_display} ይደውሉ 📞',
};

export const NOT_FOUND = {
  en: "Sorry, we couldn't find this in our list right now. We'll check and get back to you soon.",
  am: 'ይቅርታ፣ ይህን ዕቃ አሁን በዝርዝራችን ውስጥ አላገኘነውም። አጣርተን በቅርቡ እንመልስልዎታለን።',
};

export const PHOTO_UNCLEAR = {
  en: "We couldn't recognise the item in the photo. Please send its name.",
  am: 'ፎቶው ላይ ያለውን ዕቃ መለየት አልቻልንም። እባክዎ የዕቃውን ስም ይላኩልን።',
};

export const LOCATION = {
  en: '📍 {address_en}\n📞 {phone_display}',
  am: '📍 {address_am}\n📞 {phone_display}',
};

export const UNDERSTAND_PROMPT = `You read one customer message sent to ROHA Tools, a hardware and power-tools shop in Addis Ababa. The message may be Amharic, English or mixed.
Return ONLY JSON: {"intent":"price"|"search"|"greeting"|"location"|"other","keywords":["..."],"keywords_am":["..."]}
- keywords: 1-5 short English product words a shop list would use (brand, product type, size/model), e.g. ["bosch","drill","13mm"]. Translate Amharic product words to English.
- keywords_am: the Amharic product words as written, if any.
- Never add prices. Never guess a brand that is not in the message.
Message: <<<TEXT>>>`;

export const PHOTO_PROMPT = `This photo was sent by a customer of ROHA Tools, a hardware and power-tools shop. Identify the product.
Return ONLY JSON: {"product":"short English name or empty if unclear","keywords":["1-5 English words: brand, type, model, size"],"confidence":"high"|"low"}
Read any visible brand or model text. If it is not a tool or hardware item, return product "".`;

// Fill {placeholders}. Uses a function so "$" in values is safe.
export function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (values[k] ?? ''));
}
