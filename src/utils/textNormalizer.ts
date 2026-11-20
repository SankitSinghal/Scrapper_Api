export const normalizeScrapedText = (raw: string): string => {
    if(!raw || typeof raw !== "string") return "";

    return raw 
    .replace(/\u00a0/g, "")
    .replace(/(\w+)-\s*\n\s*(\w+)/g, "$1$2")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")                    
    .trim();
};

export const extractSectionWindow = (
    text: string,
    headingPattern: RegExp,
    windowSize: 600
) => {
    const match = headingPattern.exec(text);
    if(!match || match.index === undefined) return text;

    const start = Math.max(0, match.index - 50);
    return text.slice(start, start + windowSize);
};

export const sanitizeUrl = (candidate: unknown, baseUrl?: string): string | undefined => {
  if (typeof candidate !== "string") return undefined;

  // Strip angle brackets, accidental markdown link syntax, or trailing markdown fragments
  const cleaned = candidate
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/\)\s*\[.*$/, "")
    .replace(/\]\(.*$/, "");

  if (!cleaned) return undefined;

  try {
    const resolved = baseUrl ? new URL(cleaned, baseUrl).toString() : new URL(cleaned).toString();
    const parsed = new URL(resolved);

    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
};






