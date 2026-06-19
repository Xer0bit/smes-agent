export function normalizeLegacyEcomgearTags(text: string): string {
  return text.replace(
    /<\s*(\/?)\s*ecomgear-([a-z-]+)\b/gi,
    (_match: string, slash: string, tagName: string) =>
      `<${slash}dyad-${tagName.toLowerCase()}`,
  );
}

export function cleanFullResponse(text: string): string {
  const normalizedText = normalizeLegacyEcomgearTags(text);

  // Replace < characters inside dyad-* attributes with fullwidth less-than sign ＜
  // This prevents parsing issues when attributes contain HTML tags like <a> or <div>
  return normalizedText.replace(
    /<dyad-[^<>]*(?:"[^"]*"[^<>]*)*>/g,
    (match: string) => {
    // Find all attribute values (content within quotes) and replace < with ＜ and > with ＞
    const processedMatch = match.replace(
      /="([^"]*)"/g,
      (attrMatch: string, attrValue: string) => {
        const cleanedValue = attrValue.replace(/</g, "＜").replace(/>/g, "＞");
        return `="${cleanedValue}"`;
      },
    );
    return processedMatch;
    },
  );
}
