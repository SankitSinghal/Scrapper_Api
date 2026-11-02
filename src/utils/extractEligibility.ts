
export const extractEligibility = (text: string): string | null => {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }

  const normalizedText = text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = normalizedText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Find education / qualification information.
  const educationPattern =
    /\b(graduat(?:e|ion)|bachelor'?s degree|post[- ]?graduat(?:e|ion)|master'?s degree|B\.?\s?Tech|M\.?\s?Tech|B\.?\s?E\.?|M\.?\s?E\.?|B\.?\s?Sc|M\.?\s?Sc|B\.?\s?Com|M\.?\s?Com|MBA|MCA|diploma|10th|12th|higher secondary|educational qualification|professional qualification)\b/i;

  const educationLine = lines.find((line) =>
    educationPattern.test(line),
  );

  // Find the age limit heading and capture nearby text.
  const ageHeadingIndex = lines.findIndex((line) =>
    /\b(age limit|age criteria|age eligibility|minimum age|maximum age|lower age limit|upper age limit)\b/i.test(
      line,
    ),
  );

  let ageText: string | undefined;

  if (ageHeadingIndex !== -1) {
    ageText = lines
      .slice(ageHeadingIndex, ageHeadingIndex + 4)
      .join(" ")
      .slice(0, 350);
  } else {
    // Fallback when the age heading is missing from extracted PDF text.
    const ageMatch = normalizedText.match(
      /\b\d{2}\s*(?:to|-|–|—)\s*\d{2}\s*years?\b|\b\d{2}\s*years?\s*(?:to|-|–|—)\s*\d{2}\s*years?\b/i,
    );

    ageText = ageMatch?.[0];
  }

  // Find experience requirements, if present.
  const experienceLine = lines.find((line) =>
    /\b(work experience|post[- ]?qualification experience|years? of experience|experience required)\b/i.test(
      line,
    ),
  );

  const summary: string[] = [];

  if (educationLine) {
    summary.push(`Education: ${educationLine}`);
  }

  if (ageText) {
    summary.push(`Age Limit: ${ageText}`);
  }

  if (experienceLine) {
    summary.push(`Experience: ${experienceLine}`);
  }

  if (summary.length === 0) {
    return null;
  }

  return summary.join("\n");
};
