// Languages offered for the kitchen ticket.
//
// Chosen for who actually works in UK takeaway kitchens rather than by
// speaker count worldwide — a list led by Mandarin, Spanish and Hindi would
// bury Polish, Turkish and Romanian, which is who is usually reading the
// ticket.
//
// The label is sent to the model verbatim as the target language, so it has
// to read as a language name a person would write, not a code. Where a script
// matters ("Chinese (Simplified)" vs "(Traditional)") it is spelled out,
// because the two are not interchangeable on paper.
//
// Not exhaustive on purpose. If a shop needs one that is missing, adding a
// line here is the whole change.
export const KITCHEN_LANGUAGES: string[] = [
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Polish",
  "Turkish",
  "Romanian",
  "Bulgarian",
  "Portuguese",
  "Spanish",
  "Italian",
  "Greek",
  "Albanian",
  "Lithuanian",
  "Latvian",
  "Hungarian",
  "Czech",
  "Slovak",
  "Ukrainian",
  "Russian",
  "Arabic",
  "Kurdish",
  "Persian (Farsi)",
  "Urdu",
  "Punjabi",
  "Hindi",
  "Gujarati",
  "Bengali",
  "Tamil",
  "Nepali",
  "Sinhala",
  "Vietnamese",
  "Thai",
  "Korean",
  "Japanese",
  "Malay",
  "Indonesian",
  "Filipino (Tagalog)",
  "French",
  "German",
  "Dutch",
  "Somali",
  "Amharic",
  "Tigrinya",
  "Swahili",
  "Pashto",
  "Mandarin",
  "Cantonese",
];
