
import { execFile } from "node:child_process";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Exam from "../models/examModel";
import env from "../config/env";
import { CategoryFeeResult, ScraperResult, VacancyResult } from "../Types/scraperServiceType";
import { normalizeScrapedText, extractSectionWindow } from "../utils/textNormalizer";
import { sanitizeUrl } from "../utils/textNormalizer";

const IBPS_UPDATES_URL = "https://www.ibps.in/index.php/crp-updates/";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "advertisements");

const TIMEOUT_MS = env.SCRAPER_TIMEOUT;
const MAX_BUFFER = 15 * 1024 * 1024;

const allowedHosts = new Set(
  env.ALLOWED_SCRAPE_HOSTS.map((host) => host.toLowerCase()),
);

const isAllowedHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && allowedHosts.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
};

const curlBinary = process.platform === "win32" ? "curl.exe" : "curl";

export const fetchText = async(url: string): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!isAllowedHttpsUrl(url)) {
      reject(new Error(`URL is not allowlisted: ${url}`));
      return;
    }

    execFile(
      curlBinary,
      [
        "--silent",
        "--show-error",
        "--insecure", // Bypasses strict corporate/government SSL chain issues if needed
        "--max-time",
        String(Math.ceil(TIMEOUT_MS / 1000)),
        // Removed rigid --tlsv1.2 / --tls-max 1.2 to allow automatic TLS negotiation (v1.2 / v1.3)
        "--proto",
        "=https",
        "--write-out",
        "\n__HTTP_STATUS__:%{http_code}",
        url,
      ],
      {
        encoding: "utf8",
        timeout: TIMEOUT_MS + 2000,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Request failed for ${url}: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }

        const match = stdout.match(/\n__HTTP_STATUS__:(\d{3})\s*$/);

        if (!match || match.index === undefined) {
          reject(new Error(`Invalid response from ${url}`));
          return;
        }

        if (Number(match[1]) !== 200) {
          reject(new Error(`HTTP ${match[1]} returned for ${url}`));
          return;  
        }

        resolve(stdout.slice(0, match.index));
      },
    );
  });

const downloadPdf = async (url: string, destination: string): Promise<void> => {
  if (!isAllowedHttpsUrl(url)) {
    throw new Error(`PDF host is not allowed: ${url}`);
  }

  await fs.mkdir(path.dirname(destination), {
    recursive: true,
  });

  await new Promise<void>((resolve, reject) => {
    execFile(
      curlBinary,
      [
        "--silent",
        "--show-error",
        "--insecure",
        "--max-time",
        String(Math.ceil(TIMEOUT_MS / 1000)),
        "--proto",
        "=https",
        "--output",
        destination,
        "--write-out",
        "%{http_code}",
        url,
      ],
      {
        encoding: "utf8",
        timeout: TIMEOUT_MS + 2000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      async (error, stdout, stderr) => {
        if (error) {
          await fs.rm(destination, { force: true });
          reject(
            new Error(`PDF download failed: ${stderr.trim() || error.message}`),
          );
          return;
        }

        if (stdout.trim() !== "200") {
          await fs.rm(destination, { force: true });
          reject(new Error(`PDF URL returned HTTP ${stdout.trim()}`));
          return;
        }

        try {
          const stats = await fs.stat(destination);

          if (stats.size === 0 || stats.size > MAX_BUFFER) {
            throw new Error("PDF size is invalid");
          }

          const file = await fs.readFile(destination);

          if (file.subarray(0, 5).toString("ascii") !== "%PDF-") {
            throw new Error("Downloaded file is not a PDF");
          }

          resolve();
        } catch (validationError) {
          await fs.rm(destination, { force: true });
          reject(validationError);
        }
      },
    );
  });
};

const cleanText = (value: string): string =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isPdfUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return /\.pdf$/i.test(url.pathname) || /\.pdf(?:$|[?#])/i.test(value);
  } catch {
    return false;
  }
};

const getDocumentText = ($: cheerio.CheerioAPI): string => {
  const body = $("body");

  body.find("br").replaceWith("\n");
  body
    .find("p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6")
    .each((_index, element) => {
      $(element).append("\n");
    });

  return body.text().split(/\r?\n/).map(cleanText).filter(Boolean).join("\n");
};

const isUsefulTitle = (title: string, sourceUrl: string = ""): boolean => {
  if (!title || title.length < 5) return false;

  const lowerTitle = title.toLowerCase();
  const lowerUrl = sourceUrl.toLowerCase();

  const ignoredKeywords = [
    "policy", "policies", "guideline", "guidelines", "overview",
    "about us", "faq", "tenders", "rti", "feedback", "contact",
    "rules", "screen reader", "disclaimer", "terms", "history"
  ];

  const isIgnored = ignoredKeywords.some(
    (keyword) => lowerTitle.includes(keyword) || lowerUrl.includes(keyword)
  );

  if (isIgnored) return false;

  return true;
};

const parseDate = (value: string): Date | undefined => {
  const match = value.match(
    /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})[,]?\s+(\d{4})\b|\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/i,
  );

  if (!match) return undefined;

  let year: number;
  let month: number;
  let day: number;

  // Conditional Group Extraction
  if (match[4]) {
    year = Number(match[4]);
    month = Number(match[5]);
    day = Number(match[6]);
  } else if (match[7]) {
    day = Number(match[7]);
    year = Number(match[9]);
    month = new Date(`${match[8]} 1, ${year}`).getMonth() + 1;
  } else if (match[10]) {
    month = new Date(`${match[10]} 1, 2000`).getMonth() + 1;
    day = Number(match[11]);
    year = Number(match[12]);
  } else {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  }

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12
  ) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return date;
};

export const extractExamFields = (text: string) => {
  const fields: any = {
    dates: {},
    eligibility: {},
    vacancies: {},
  };

  if (!text || typeof text !== "string") return fields;

  const cleanTextContent = text.replace(/\s+/g, " ");

  // Advertisement Number
  const advMatch = text.match(/advt\.?\s*(no\.?|[:-])\s*([A-Za-z0-9\-/]+)/i);
  if (advMatch) {
    fields.advertisementNumber = advMatch[2];
  }

  // 1. IMPROVED FLEXIBLE DATE EXTRACTORS
  const startDateRegex = /(?:start(?:ing)?|opening|commencement|from|online registration(?:\s*from|[:\s]*starts?))[:\s]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{2,4})/i;
  const endDateRegex = /(?:last|closing|end|due|till|deadline|closure of online registration)[:\s]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{2,4})/i;

  const startMatch = cleanTextContent.match(startDateRegex);
  if (startMatch && startMatch[1]) {
    const parsedStart = parseDate(startMatch[1]); // Ensure parseDate is imported/defined
    if (parsedStart) fields.dates.applicationStartDate = parsedStart;
  }

  const endMatch = cleanTextContent.match(endDateRegex);
  if (endMatch && endMatch[1]) {
    const parsedEnd = parseDate(endMatch[1]); // Ensure parseDate is imported/defined
    if (parsedEnd) fields.dates.applicationEndDate = parsedEnd;
  }
  
  if (!fields.dates.applicationStartDate || !fields.dates.applicationEndDate) {
    const allDates: Date[] = [];
    const dateRegexGlobal = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})[,]?\s+(\d{4})\b/g;
    let match;
    while ((match = dateRegexGlobal.exec(cleanTextContent)) !== null) {
      const d = parseDate(match[0]);
      if (d) allDates.push(d);
    }
    if (allDates.length > 0 && !fields.dates.applicationStartDate) {
      fields.dates.applicationStartDate = allDates[0];
    }
    if (allDates.length > 1 && !fields.dates.applicationEndDate) {
      fields.dates.applicationEndDate = allDates[1];
    }
  }

  // 2. FLEXIBLE AGE LIMIT EXTRACTORS
  const ageMatch = cleanTextContent.match(
    /(?:age\s*limit|age)[:\s]*(?:not\s*below\s*)?([0-9]{1,2})\s*(?:to|-)\s*([0-9]{1,2})\s*years?/i,
  );
  if (ageMatch) {
    fields.eligibility.minAge = parseInt(ageMatch[1], 10);
    fields.eligibility.maxAge = parseInt(ageMatch[2], 10);
  } else {
    const minAgeMatch = cleanTextContent.match(
      /(?:min(?:imum)?\s*age)[:\s]*([0-9]{1,2})/i,
    );
    if (minAgeMatch) fields.eligibility.minAge = parseInt(minAgeMatch[1], 10);

    const maxAgeMatch = cleanTextContent.match(
      /(?:max(?:imum)?\s*age)[:\s]*([0-9]{1,2})/i,
    );
    if (maxAgeMatch) fields.eligibility.maxAge = parseInt(maxAgeMatch[1], 10);
  }

  // 3. FLEXIBLE VACANCY EXTRACTORS (Consolidated to avoid duplicate checks)
  const vacancyMatch = cleanTextContent.match(
    /(?:total\s*(?:vacancies|posts)|number\s*of\s*vacancies|vacancies|posts)[:\s]*([0-9,]+)/i,
  );
  if (vacancyMatch && vacancyMatch[1]) {
    const cleanedNum = parseInt(vacancyMatch[1].replace(/,/g, ""), 10);
    if (!isNaN(cleanedNum)) {
      fields.totalVacancies = cleanedNum;
      fields.vacancies.total = cleanedNum;
    }
  }

  // 4. FLEXIBLE QUALIFICATION EXTRACTORS
  const qualKeywords =
    /(?:educational qualification|qualification|eligibility|degree|essential academic qualifications)[:\s]*([^\.\n]{15,120})/i;
  const qualMatch = cleanTextContent.match(qualKeywords);
  if (qualMatch && qualMatch[1]) {
    fields.eligibility.minQualification = qualMatch[1].trim();
    fields.eligibility.requiredDegree = qualMatch[1].trim();
  }

  const isBoilerplate = 
    /Home About Us|Organisational Structure|Management & Faculty|Governing Board|Policies, Rules & Guidelines/i.test(cleanTextContent);

  // Only assign overview if it has actual exam/notification text and isn't boilerplate menu text
  if (!isBoilerplate && cleanTextContent.length > 100) {
    fields.eligibility.overview = cleanTextContent.slice(0, 600);
  }

  return fields;
};

const getPdfLinks = (
  $: cheerio.CheerioAPI,
  baseUrl: string,
): Array<{ url: string; label: string }> => {
 
  const links = new Map<string, string>();

  $("a[href]").each((_index, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");

    if (!href) return;

    try {
      const url = new URL(href, baseUrl);
      if (!isAllowedHttpsUrl(url.href)) return;
      const linkText = cleanText(
        `${anchor.text()} ${anchor.attr("title") ?? ""} ${href}`,
      );
      const rowText = cleanText(anchor.closest("tr, li, p, div").text());
      const isPdf = isPdfUrl(url.href);

      const isAdvertisement =
        /advertisement|notification|detailed|advt|crp|recruitment|vacancy|information handout/i.test(
          `${linkText} ${rowText}`,
        );

      if (isPdf && isAdvertisement) {
        links.set(url.href, cleanText(`${linkText} ${rowText}`));
      }
    } catch {
      // Ignore invalid URLs.
    }
  });

  return [...links.entries()].map(([url, label]) => ({
    url,
    label,
  }));
};

const getAdmitCardUrl = (
  $: cheerio.CheerioAPI,
  baseUrl: string,
  pdfLinks: Array<{url: string, label: string}> = []
): string | undefined => {
  let result: string | undefined;

  $("a[href]").each((_index, element) => {
    if (result) return;

    const anchor = $(element);
    const href = anchor.attr("href");
    const surroundingText = cleanText(
      `${anchor.text()} ${anchor.closest("tr, li, p").text()} ${href ?? ""}`,
    );

    if (!/admit\s*card|call\s*letter|hall\s*ticket|download.*call/i.test(surroundingText)) {
      return;
    }

    if (!href) return;

    try {
      const url = new URL(href, baseUrl);

      if (isAllowedHttpsUrl(url.href)) {
        result = url.href;
        // console.log("Valid Admit Card URL extracted:", result);
      }
    } catch {
      // Ignore malformed URLs.
    }
  });

  if (!result && pdfLinks.length > 0) {
    const callLetterPdf = pdfLinks.find(({ label, url }) =>
      /admit\s*card|call\s*letter|hall\s*ticket/i.test(`${label} ${url}`)
    );
    if (callLetterPdf) {
      result = callLetterPdf.url;
    }
  }

  return result;
};

// export const scrapeIBPSUpdates = async (): Promise<ScraperResult> => {

//   if (!isAllowedHttpsUrl(IBPS_UPDATES_URL)) {
//     throw new Error("IBPS updates URL is not allowlisted");
//   }

//   const html = await fetchText(IBPS_UPDATES_URL);
//   const $ = cheerio.load(html);

//   $("script, style, noscript, svg").remove();

//   const candidatesMap = new Map<
//     string,
//     { title: string; sourceUrl: string; advertisementUrl?: string }
//   >();

//   const addCandidate = (
//     title: string,
//     sourceUrl: string,
//     advertisementUrl?: string,
//   ) => {
//     const lowerTitle = title.toLowerCase();
//     if (
//       sourceUrl.includes('/services') || 
//       sourceUrl.includes('/gallery') || 
//       sourceUrl.includes('/contact-us') ||
//       sourceUrl.includes('/about-us') ||
//       sourceUrl.includes('/chairmen') ||
//       sourceUrl.includes('/founders') ||
//       sourceUrl.includes('/governingboard') ||
//       sourceUrl.includes('/directorsmessage') ||
//       sourceUrl.includes('/ourhighlights') ||
//       sourceUrl.includes('/organisational-') ||
//       lowerTitle.includes('organisational') ||
//       lowerTitle.includes('governing board') ||
//       lowerTitle.includes('founders') ||
//       lowerTitle.includes('director')
//     ) {
//       return;
//     }

//     if (!isUsefulTitle(title, sourceUrl)) return;
//     const existing = candidatesMap.get(sourceUrl);
//     if (existing) {
//       if (!existing.advertisementUrl && advertisementUrl) {
//         existing.advertisementUrl = advertisementUrl;
//       }
//     } else {
//       candidatesMap.set(sourceUrl, { title, sourceUrl, advertisementUrl });
//     }
//   };

//   $("tr").each((_index, element) => {
//     const row = $(element);
//     const links = row.find("a[href]");
//     const rowPdfLinks: Array<{ url: string; label: string; title: string }> = [];
//     const rowCandidates: Array<{ title: string; sourceUrl: string }> = [];

//     links.each((_linkIndex, link) => {
//       const anchor = $(link);
//       const label = cleanText(anchor.text());
//       const href = anchor.attr("href");

//       if (!href) return;

//       try {
//         const url = new URL(href, IBPS_UPDATES_URL);
//         if (!isAllowedHttpsUrl(url.href)) return;

//         if (isPdfUrl(url.href)) {
//           const title = cleanText(anchor.text() || anchor.attr("title") || "");
//           rowPdfLinks.push({
//             url: url.href,
//             label: cleanText(`${title} ${href}`),
//             title,
//           });
//           return;
//         }

//         if (isUsefulTitle(label)) {
//           rowCandidates.push({ title: label, sourceUrl: url.href });
//         }
//       } catch {
//         // Ignore malformed URLs.
//       }
//     });

//     if (rowCandidates.length > 0) {
//       const advertisementPdf =
//         rowPdfLinks.find(({ label }) =>
//           /advertisement|notification|detailed|advt|crp|recruitment|vacancy|information handout/i.test(
//             label,
//           ),
//         ) ?? rowPdfLinks[0];

//       for (const candidate of rowCandidates) {
//         addCandidate(
//           candidate.title,
//           candidate.sourceUrl,
//           advertisementPdf?.url,
//         );
//       }
//     } else {
//       for (const pdfLink of rowPdfLinks) {
//         if (!isUsefulTitle(pdfLink.title)) continue;
//         addCandidate(pdfLink.title, pdfLink.url, pdfLink.url);
//       }
//     }
//   });

//   if (candidatesMap.size === 0) {
//     $("a[href]").each((_index, element) => {
//       const anchor = $(element);
//       const title = cleanText(anchor.text());
//       const href = anchor.attr("href");

//       if (!href) return;

//       try {
//         const url = new URL(href, IBPS_UPDATES_URL);
//         if (!isAllowedHttpsUrl(url.href)) return;

//         if (isUsefulTitle(title, url.href)) {
//           if (isPdfUrl(url.href)) {
//             addCandidate(title, url.href, url.href);
//           } else {
//             addCandidate(title, url.href);
//           }
//         }
//       } catch {
//         // Ignore malformed URLs.
//       }
//     });
//   }

//   const cleanOverviewText = (text: string): string => {
//     if (!text) return "";
//     return text
//       .replace(/^[\s\-–—_]+/, "") 
//       .replace(/[\s\-–—_]+$/, "") 
//       .replace(/[-–—]{3,}/g, " ") 
//       .replace(/\s+/g, " ")      
//       .trim();
//   };

//   const parseVacanciesData = (text: string): VacancyResult => {
//     if (!text || typeof text !== "string") return { total: 0 };

//     const cleanText = text.replace(/\s+/g, " ");
//     let total = 0;

//     const patterns = [
//       /(?:total\s*(?:posts|vacancies|seats|number)?|number\s*of\s*vacancies|vacancies|posts)\s*(?:is|are|[:\s-])*\s*([\d,]{1,6})/i,
//       /(\d{1,6})\s*(?:posts|vacancies|seats)\s*(?:are\s*available|total)?/i
//     ];

//     for (const pattern of patterns) {
//       const match = cleanText.match(pattern);
//       if (match && match[1]) {
//         const parsed = parseInt(match[1].replace(/,/g, ""), 10);
//         if (!isNaN(parsed) && parsed > 0) {
//           total = parsed;
//           break;
//         }
//       }
//     }

//     return { total };
//   };

//   const parseCategoryFees = (text: string): CategoryFeeResult => {
//     const defaultFees = { general: 0, obc: 0, sc: 0, st: 0, ews: 0, pwd: 0, female: 0 };
    
//     if (!text || typeof text !== "string") {
//       return { applicationFee: 0, categoryWiseFee: defaultFees };
//     }

//     const cleanText = text.replace(/\s+/g, " ");
//     let defaultFee = 0;

//     const extractFeeFromSnippet = (snippet: string): number => {
//       const match = snippet.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{2})?)/i) || snippet.match(/\b([1-9]\d{2,4})\/-\b/);
//       if (match && match[1]) {
//         const parsed = parseInt(match[1].replace(/,/g, ""), 10);
//         if (!isNaN(parsed) && parsed > 0) return parsed;
//       }
//       return 0;
//     };

//     const groupPatterns = [
//       { 
//         regex: /(?:sc\s*\/?\s*st\s*\/?\s*(?:pwd|pwbd))\s*[^\\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i, 
//         targets: ['sc', 'st', 'pwd'] 
//       },
//       { 
//         regex: /(?:general\s*\/?\s*obc\s*\/?\s*ews|all\s*other\s*categories?|other\s*than\s*sc)\s*[^\\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i, 
//         targets: ['general', 'obc', 'ews'] 
//       },
//       { 
//         regex: /(?:for\s*all\s*other)\s*[^\\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i, 
//         targets: ['general', 'obc', 'ews'] 
//       }
//     ];

//     const fees = { ...defaultFees };
//     for (const group of groupPatterns) {
//       const match = cleanText.match(group.regex);
//       if (match && match[1]) {
//         const feeVal = extractFeeFromSnippet(match[1]);
//         if (feeVal > 0) {
//           for (const target of group.targets) {
//             fees[target as keyof typeof fees] = feeVal;
//           }
//         }
//       }
//     }

//     const extractFeeFor = (keywords: string[]): number => {
//       for (const kw of keywords) {
//         const zeroRegex = new RegExp(`\\b${kw}\\b[^\\w]{0,30}\\b(nil|no\\s*fee|exempted|free|\\b0\\b)\\b`, "i");
//         if (zeroRegex.test(cleanText)) return 0;

//         const fwdRegex = new RegExp(`\\b${kw}\\b[^\\d]{0,35}(?:rs\\.?|inr|₹)?\\s*([\\d,]{2,5})`, "i");
//         const fwdMatch = cleanText.match(fwdRegex);
//         if (fwdMatch && fwdMatch[1]) {
//           const parsed = parseInt(fwdMatch[1].replace(/,/g, ""), 10);
//           if (!isNaN(parsed)) return parsed;
//         }

//         const bwdRegex = new RegExp(`(?:rs\\.?|inr|₹)?\\s*([\\d,]{2,5})[^\\d]{0,35}\\b${kw}\\b`, "i");
//         const bwdMatch = cleanText.match(bwdRegex);
//         if (bwdMatch && bwdMatch[1]) {
//           const parsed = parseInt(bwdMatch[1].replace(/,/g, ""), 10);
//           if (!isNaN(parsed)) return parsed;
//         }
//       }
//       return 0;
//     };

//     if (fees.general === 0) fees.general = extractFeeFor(["general", "ur", "unreserved", "all other"]);
//     if (fees.obc === 0) fees.obc = extractFeeFor(["obc", "other backward class", "bc"]);
//     if (fees.ews === 0) fees.ews = extractFeeFor(["ews", "economically weaker"]);
//     if (fees.sc === 0) fees.sc = extractFeeFor(["sc", "scheduled caste"]);
//     if (fees.st === 0) fees.st = extractFeeFor(["st", "scheduled tribe"]);
//     if (fees.pwd === 0) fees.pwd = extractFeeFor(["pwd", "pwbd", "handicapped", "benchmark disabilities"]);
//     if (fees.female === 0) fees.female = extractFeeFor(["female", "women"]);

//     const generalFeeMatch = cleanText.match(/(?:application fee|fee payable|examination fee|charges)[:\s-]*(?:rs\.?|inr|₹)?\s*([\\d,]{2,5})/i);
//     if (generalFeeMatch && generalFeeMatch[1]) {
//       defaultFee = parseInt(generalFeeMatch[1].replace(/,/g, ""), 10) || 0;
//     }

//     if (fees.general === 0) fees.general = defaultFee;
//     if (fees.obc === 0) fees.obc = fees.general;
//     if (fees.ews === 0) fees.ews = fees.general;

//     const finalAppFee = defaultFee || fees.general;

//     return {
//       applicationFee: finalAppFee,
//       categoryWiseFee: fees,
//     };
//   };

//   const parseAgeLimitData = (text: string): { minAge: string; maxAge: string; relaxations?: string } => {
//   const defaultAge = { minAge: "20", maxAge: "30", relaxations: "OBC: 3 Yrs, SC/ST: 5 Yrs" };
//   if (!text || typeof text !== "string") return defaultAge;

//   const cleanText = text.replace(/\s+/g, " ");
//   let minAge = "";
//   let maxAge = "";

//   // 1. Try to catch direct ranges first (e.g., "20 to 30 years", "21-30 years", "Between 20 and 30 years")
//   const rangeMatch = cleanText.match(/(?:between\s*)?(\d{2})\s*(?:to|and|[-–])\s*(\d{2})\s*years?/i);
//   if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
//     minAge = rangeMatch[1];
//     maxAge = rangeMatch[2];
//   }

//   // 2. If no range found, search for specific minimum age phrases
//   if (!minAge) {
//     const minMatch = cleanText.match(/(?:minimum\s*age|min\.?\s*age|not\s*less\s*than|not\s*below|above)\s*[:\s-]*(\d{1,2})\s*years?/i);
//     if (minMatch && minMatch[1]) {
//       minAge = minMatch[1];
//     }
//   }

//   // 3. If no max found, search for specific maximum age phrases
//   if (!maxAge) {
//     const maxMatch = cleanText.match(/(?:maximum\s*age|max\.?\s*age|not\s*more\s*than|not\s*above|below|up\s*to)\s*[:\s-]*(\d{1,2})\s*years?/i);
//     if (maxMatch && maxMatch[1]) {
//       maxAge = maxMatch[1];
//     }
//   }

//   // 4. Final fallback defaults if nothing matched
//   if (!minAge) minAge = "20";
//   if (!maxAge) maxAge = "30";

//   // Extract relaxation text dynamically if present
//   const relaxationMatch = cleanText.match(/(?:age\s*relaxation|relaxation\s*of\s*upper\s*age|upper\s*age\s*limit\s*shall\s*be\s*relaxed)[^.]*\./i);
//   const relaxations = relaxationMatch ? relaxationMatch[0] : "OBC: 3 Yrs, SC/ST: 5 Yrs, PwD: 10 Yrs";

//   return { minAge, maxAge, relaxations };
// };

// const parseExamDate = (text: string): string => {
//   if (!text || typeof text !== "string") return "To be announced";
//   const cleanText = text.replace(/\s+/g, " ");

//   const keywordMatch = cleanText.match(
//     /(?:exam(?:ination)?\s*date|held\s*on|tentative\s*date|preliminary\s*exam(?:ination)?|online\s*exam)[^0-9]*(?:[:\s-]*)(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[a-zA-Z]+\s+\d{4}|[a-zA-Z]+\s+\d{4})/i
//   );

//   if (keywordMatch && keywordMatch[1]) {
//     const rawDate = keywordMatch[1].trim();
//     const parsed = Date.parse(rawDate);
//     if (!isNaN(parsed)) {
//       return new Date(parsed).toISOString().split('T')[0];
//     }
//     return rawDate; 
//   }

//   // 2. Fallback: Search for general calendar date formats near exam context
//   const generalDateMatch = cleanText.match(/\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/);
//   if (generalDateMatch && generalDateMatch[1]) {
//     const parsed = Date.parse(generalDateMatch[1].replace(/\./g, '-').replace(/\//g, '-'));
//     if (!isNaN(parsed)) {
//       return new Date(parsed).toISOString().split('T')[0];
//     }
//   }

//   // 3. Fallback: Look for Month & Year patterns common in IBPS calendars (e.g., "August/September 2026")
//   const monthYearMatch = cleanText.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*(?:to|-)?\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)?\s*\d{4}/i);
//   if (monthYearMatch) {
//     return monthYearMatch[0];
//   }
//   return "To be announced";
// };

//   const extractEligibility = (text: string): { overview: string; qualification?: string } => {
//   if (!text || typeof text !== "string") return { overview: "" };

//   const cleanedText = text.replace(/\s+/g, " ");
  
//   // Improved sentence split that avoids breaking on common abbreviations like B.A., M.Sc., No., etc.
//   const sentences = cleanedText.split(/(?<!\b[A-Z])(?<=[.?!])\s+/);
  
//   const educationKeywords = [
//     "degree", "graduation", "graduate", "post graduate", "post-graduate",
//     "ug", "pg", "bachelor", "master", "discipline", "qualification", "eligibility"
//   ];

//   const matchedSentences: string[] = [];
//   let detectedQualification = "Graduate Degree in any discipline";

//   for (const sentence of sentences) {
//     const lower = sentence.toLowerCase();
//     const isEduRelevant = educationKeywords.some((keyword) => lower.includes(keyword));
    
//     if (isEduRelevant && sentence.length > 15) {
//       matchedSentences.push(sentence.trim());
      
//       // Check for Postgraduate first so it doesn't get overridden by general 'graduate' matches
//       if (/post\s*graduate|pg|master|doctorate|ph\.?d/i.test(lower)) {
//         detectedQualification = "Postgraduate (PG) / Master's Degree";
//       } else if (/under\s*graduate|ug|bachelor|graduat(e|ion)|degree/i.test(lower)) {
//         detectedQualification = "Undergraduate (UG) / Bachelor's Degree";
//       }
//     }
//   }

//   const overview = matchedSentences.length > 0 
//     ? matchedSentences.slice(0, 3).join(" ") 
//     : cleanedText.slice(0, 300);

//   return {
//     overview: typeof cleanOverviewText === "function" ? cleanOverviewText(overview) : overview,
//     qualification: detectedQualification,
//   };
// };

//   //Link Resolution helper 
//   const isLikelyPdf = (url?: string): boolean => {
//   if (!url) return false;
//   return isPdfUrl(url) || /\.pdf($|\?)/i.test(url);
// };

// const extractApplyOnlineFromPage = (
//   detailPage: cheerio.CheerioAPI,
//   baseUrl: string
// ): string | undefined => {
//   let foundApplyUrl: string | undefined;

//   detailPage("a[href]").each((_idx, el) => {
//     if (foundApplyUrl) return;
//     const anchor = detailPage(el);
//     const href = anchor.attr("href");
//     const text = cleanText(`${anchor.text()} ${anchor.attr("title") || ""} ${href || ""}`);

//     if (!href || !/apply\s*online|online\s*application|click\s*here\s*to\s*apply/i.test(text)) {
//       return;
//     }

//     const sanitized = sanitizeUrl(href, baseUrl);
//     if (sanitized && isAllowedHttpsUrl(sanitized) && !isLikelyPdf(sanitized)) {
//       foundApplyUrl = sanitized;
//     }
//   });

//   return foundApplyUrl;
// };

// const buildExamLinks = (params: {
//   sourceUrl: string;
//   advertisementUrl?: string;
//   admitCardUrl?: string;
//   applyPageUrl?: string;
// }) => {
//   const cleanSource =
//     sanitizeUrl(params.sourceUrl, IBPS_UPDATES_URL) ?? IBPS_UPDATES_URL;
//   const sourceIsPdf = isLikelyPdf(cleanSource);

//   const rawPdf =
//     params.advertisementUrl || (sourceIsPdf ? cleanSource : undefined);
//   const cleanPdf = sanitizeUrl(rawPdf, IBPS_UPDATES_URL) ?? "";

//   const cleanApplyCandidate = sanitizeUrl(params.applyPageUrl, IBPS_UPDATES_URL);
//   const cleanApplyOnline =
//     cleanApplyCandidate && !isLikelyPdf(cleanApplyCandidate)
//       ? cleanApplyCandidate
//       : !sourceIsPdf
//         ? cleanSource
//         : "https://www.ibps.in";

//   const cleanAdmitCard = sanitizeUrl(params.admitCardUrl, IBPS_UPDATES_URL);

//   return {
//     applyOnline: cleanApplyOnline,
//     notificationPdf: cleanPdf,
//     officialWebsite: "https://www.ibps.in",
//     sourceUrl: cleanSource,
//     ...(cleanAdmitCard ? { admitCardUrl: cleanAdmitCard } : {}),
//   };
// };

//   const results = new Map<string, any>();

//   for (const candidate of candidatesMap.values()) {
//     let detailHtml = "";
//     let aggregatedText = "";

//     if (!isPdfUrl(candidate.sourceUrl)) {
//       try {
//         detailHtml = await fetchText(candidate.sourceUrl);
//       } catch {
//         const recruitmentId = crypto
//           .createHash("sha256")
//           .update(candidate.sourceUrl)
//           .digest("hex");
          
//         results.set(candidate.sourceUrl, {
//           recruitmentId,
//           title: candidate.title,
//           org: "Institute of Banking Personnel Selection (IBPS)",
//           sector: "BANKING",
//           posts: "Not Announced",
//           qualification: "Graduate Degree in any discipline",
//           lastDate: "2026-12-31",
//           fees: {
//             generalObc: "850",
//             scStPwdFemale: "175"
//           },
//           ageLimit: {
//             minAge: "20",                                                            
//             maxAge: "30",
//             cutoffDate: "As per official notification",
//             relaxations: "OBC: 3 Yrs, SC/ST: 5 Yrs"
//           },
//           links: {
//             applyOnline: candidate.sourceUrl,
//             officialWebsite: "https://www.ibps.in",
//             sourceUrl: candidate.sourceUrl,
//           },
//         });
//         continue;
//       }
//     }

//     const detailPage = cheerio.load(detailHtml);
//     detailPage("script, style, noscript, svg").remove();

//     const detailText = getDocumentText(detailPage);
//     aggregatedText = normalizeScrapedText(`${aggregatedText} ${detailText}`);

//     const pdfLinks = getPdfLinks(detailPage, candidate.sourceUrl);
//     // const admitCardUrl = getAdmitCardUrl(detailPage, candidate.sourceUrl, pdfLinks);
//     const admitCardUrl = detailHtml
//   ? extractApplyOnlineFromPage(detailPage, candidate.sourceUrl)
//   : undefined;
    
//     const extractedFields = extractExamFields(aggregatedText);
//     const eligibilityResult = extractEligibility(aggregatedText);
    
//     // let vacancyData = parseVacanciesData(aggregatedText);
//     // let feeData = parseCategoryFees(aggregatedText);
//     // let ageData = parseAgeLimitData(aggregatedText);
   
//     let vacancyData = parseVacanciesData(
//       extractSectionWindow(aggregatedText, /vacancy|vacancies|post|posts/i, 600)
//     );
//     let feeData = parseCategoryFees(
//       extractSectionWindow(aggregatedText, /application\s*fee|intimation\s*charges|fee\s*payable/i, 600)
//     );
//     let ageData = parseAgeLimitData(
//       extractSectionWindow(aggregatedText, /age\s*limit|upper\s*age|eligibility\s*criteria/i, 600)
//     );

//     let advertisementPdf = candidate.advertisementUrl
//       ? { url: candidate.advertisementUrl, label: "advertisement" }
//       : pdfLinks.find(({ url, label }) =>
//           /advertisement|notification|detailed|advt|crp|recruitment|information\s*handout/i.test(
//             `${label} ${url}`,
//           ),
//         );

//     if (!advertisementPdf && pdfLinks.length > 0) {
//       advertisementPdf = pdfLinks[0];
//     }

//     if (advertisementPdf) {
//       const advertisementUrl = advertisementPdf.url;
//       const filename = `${crypto.createHash("sha256").update(advertisementUrl).digest("hex")}.pdf`;
//       const absolutePath = path.join(UPLOAD_DIR, filename);

//       try {
//         await downloadPdf(advertisementUrl, absolutePath);

//         const pdfBuffer = await fs.readFile(absolutePath);
//         const parsed = await pdfParse(pdfBuffer);
//         const pdfText = normalizeScrapedText(parsed.text ?? "");   
        
//         aggregatedText = normalizeScrapedText(`${aggregatedText} ${pdfText}`);

//         const pdfFields = extractExamFields(pdfText);
//         const pdfEligibility = 
//         typeof pdfFields.eligibility?.overview === "string" &&
//         pdfFields.eligibility.overview.trim().length >= 20
//           ? { overview: pdfFields.eligibility.overview.trim(), qualification: "Graduate Degree in any discipline" }
//           : extractEligibility(pdfText);

//         // vacancyData = parseVacanciesData(aggregatedText);
//         // feeData = parseCategoryFees(aggregatedText);
//         // let extractedExamDate = parseExamDate(aggregatedText);

//         vacancyData = parseVacanciesData(
//           extractSectionWindow(aggregatedText, /vacancy|vacancies|post|posts/i, 600)
//         );
//         feeData = parseCategoryFees(
//           extractSectionWindow(aggregatedText, /application\s*fee|intimation\s*charges|fee\s*payable/i, 600)
//         );
//         ageData = parseAgeLimitData(
//           extractSectionWindow(aggregatedText, /age\s*limit|upper\s*age|eligibility\s*criteria/i, 600)
//         );
//         const extractedExamDate = parseExamDate(
//           extractSectionWindow(aggregatedText, /schedule|examination|preliminary|main\s*exam|call\s*letter/i, 600)
//         );

//         const finalEligibility = pdfEligibility.overview ? pdfEligibility : eligibilityResult;

//         const applyEndStr = extractedFields.dates?.applicationEndDate 
//           ? new Date(extractedFields.dates.applicationEndDate).toISOString().split('T')[0]
//           : "2026-12-31";

//           const cleanApplyOnline = sanitizeUrl(candidate.sourceUrl, IBPS_UPDATES_URL);
//           const cleanNotificationPdf = sanitizeUrl(advertisementUrl, IBPS_UPDATES_URL);
//           const cleanAdmitCardUrl = sanitizeUrl(admitCardUrl, IBPS_UPDATES_URL);

//         const exam: any = {
//           recruitmentId: crypto
//             .createHash("sha256")
//             .update(candidate.sourceUrl)
//             .digest("hex"),
//           title: candidate.title,
//           org: "Institute of Banking Personnel Selection (IBPS)",
//           sector: "BANKING",
//           posts: vacancyData.total > 0 ? String(vacancyData.total) : "Not Announced",
//           qualification: finalEligibility.qualification || "Graduate Degree in any discipline",
//           lastDate: applyEndStr,
//           location: "All India",
//           category: "Banking",
//           status: "apply",
//           featured: false,
//           fees: {
//             generalObc: String(feeData.categoryWiseFee.general || 850),
//             scStPwdFemale: String(feeData.categoryWiseFee.sc || 175),
//             paymentMode: "Online (UPI, Net Banking, Debit/Credit Card)"
//           },
//           ageLimit: {
//           minAge: ageData.minAge,
//           maxAge: ageData.maxAge,
//           cutoffDate: "As per official notification",
//           relaxations: ageData.relaxations
//         },
//           links: {
//             applyOnline: cleanApplyOnline ?? candidate.sourceUrl,
//             notificationPdf: cleanNotificationPdf ?? "",
//             officialWebsite: "https://www.ibps.in",
//             sourceUrl: cleanApplyOnline ?? candidate.sourceUrl,
//             ...(cleanAdmitCardUrl ? { admitCardUrl: cleanAdmitCardUrl } : {}),
//         },
//           importantDates: {
//             applyStart: extractedFields.dates?.applicationStartDate ? new Date(extractedFields.dates.applicationStartDate).toISOString().split('T')[0] : undefined,
//             applyEnd: applyEndStr,
//             examDate: extractedExamDate,
//             admitCardDate: admitCardUrl || "4 Days before Exam",
//             resultDate: "To be announced"
//           }
//         };

//         results.set(candidate.sourceUrl, exam);
//         continue;
//       } catch (error) {
//         console.error(`PDF processing failed for ${candidate.title}:`, error);
//       }
//     }

//     const applyEndFallback = extractedFields.dates?.applicationEndDate 
//       ? new Date(extractedFields.dates.applicationEndDate).toISOString().split('T')[0]
//       : "2026-12-31";

//     const exam: any = {
//       recruitmentId: crypto
//         .createHash("sha256")
//         .update(candidate.sourceUrl)
//         .digest("hex"),
//       title: candidate.title,
//       org: "Institute of Banking Personnel Selection (IBPS)",
//       sector: "BANKING",
//       posts: vacancyData.total > 0 ? String(vacancyData.total) : "Not Announced",
//       qualification: eligibilityResult.qualification || "Graduate Degree in any discipline",
//       lastDate: applyEndFallback,
//       location: "All India",
//       category: "Banking",
//       status: "apply",
//       featured: false,
//       fees: {
//         generalObc: String(feeData.categoryWiseFee.general || 850),
//         scStPwdFemale: String(feeData.categoryWiseFee.sc || 175),
//         paymentMode: "Online"
//       },
//       ageLimit: {
//       minAge: ageData.minAge,       // e.g., "20"
//       maxAge: ageData.maxAge,       // e.g., "30"
//       cutoffDate: "As per official notification",
//       relaxations: ageData.relaxations
//   },
//       links: {
//         applyOnline: candidate.sourceUrl,
//         notificationPdf: candidate.advertisementUrl || "",
//         officialWebsite: "https://www.ibps.in",
//         sourceUrl: candidate.sourceUrl,
//       },
//       importantDates: {
//         applyEnd: applyEndFallback,
//         examDate: "To be announced"
//       }
//     };

//     results.set(candidate.sourceUrl, exam);
//   }

//   let saved = 0;
//   let dataChangesDetected = 0;

//   for (const [sourceUrl, examData] of results.entries()) {
//     const exam = examData as any;

//     const validSourceUrl = sourceUrl || exam.links?.sourceUrl || exam.title;
//     const recruitmentId = exam.recruitmentId || crypto
//       .createHash("sha256")
//       .update(validSourceUrl)
//       .digest("hex");

//       const existingExam = await Exam.findOne({ "links.sourceUrl": sourceUrl });

//       if (existingExam && existingExam.importantDates) {
//       const oldDates = existingExam.importantDates;
//       const newDates = exam.importantDates || {};

//       // 2. Compare critical dates to see if anything changed on the website
//       if (
//         oldDates.applyStart !== newDates.applyStart ||
//         oldDates.applyEnd !== newDates.applyEnd ||
//         oldDates.examDate !== newDates.examDate ||
//         oldDates.admitCardDate !== newDates.admitCardDate ||
//         oldDates.resultDate !== newDates.resultDate
//       ) {
//         dataChangesDetected++;
        
//         console.warn(`[IBPS Schedule Update Detected] Exam: "${exam.title}"`);
//         console.log(`   - Old Exam Date: ${oldDates.examDate || "N/A"} -> New Exam Date: ${newDates.examDate || "N/A"}`);
//         console.log(`   - Old Last Date: ${oldDates.applyEnd || "N/A"} -> New Last Date: ${newDates.applyEnd || "N/A"}`);
//       }
//     }

//     const finalApplyOnline = sanitizeUrl(exam.links?.applyOnline, IBPS_UPDATES_URL) ?? validSourceUrl;
//     const finalNotificationPdf = sanitizeUrl(exam.links?.notificationPdf, IBPS_UPDATES_URL) ?? "";
//     const finalAdmitCardUrl = sanitizeUrl(exam.links?.admitCardUrl, IBPS_UPDATES_URL);

//     await Exam.updateOne(
//       { "links.sourceUrl": sourceUrl },
//       {
//         $set: {
//           recruitmentId, // Ensure recruitmentId is always updated/set and never null
//           title: exam.title,
//           org: exam.org,
//           sector: exam.sector,
//           posts: exam.posts,
//           qualification: exam.qualification,
//           lastDate: exam.lastDate,
//           location: exam.location,
//           category: exam.category,
//           status: exam.status,
//           featured: exam.featured,
//           fees: exam.fees,
//           ageLimit: exam.ageLimit,
//           links: {
//           applyOnline: finalApplyOnline,
//           notificationPdf: finalNotificationPdf,
//           officialWebsite: "https://www.ibps.in",
//           sourceUrl: validSourceUrl,
//           ...(finalAdmitCardUrl ? { admitCardUrl: finalAdmitCardUrl } : {}),
//       },
//           importantDates: exam.importantDates,
//           lastScrapedAt: new Date(),
//         },
//       },
//       {
//         upsert: true,
//         runValidators: true,
//       },
//     );
//     saved += 1;
//   }

//   return {
//     found: results.size,
//     saved,
//     announcements: [...results.values()],
//   };
// };

export const scrapeIBPSUpdates = async (): Promise<ScraperResult> => {
  if (!isAllowedHttpsUrl(IBPS_UPDATES_URL)) {
    throw new Error("IBPS updates URL is not allowlisted");
  }

  const html = await fetchText(IBPS_UPDATES_URL);
  const $ = cheerio.load(html);

  $("script, style, noscript, svg").remove();

  const candidatesMap = new Map<
    string,
    { title: string; sourceUrl: string; advertisementUrl?: string }
  >();

  const addCandidate = (
    title: string,
    sourceUrl: string,
    advertisementUrl?: string,
  ) => {
    const lowerTitle = title.toLowerCase();
    const lowerUrl = sourceUrl.toLowerCase();

    if (
      lowerUrl.includes("/services") ||
      lowerUrl.includes("/gallery") ||
      lowerUrl.includes("/contact-us") ||
      lowerUrl.includes("/about-us") ||
      lowerUrl.includes("/chairmen") ||
      lowerUrl.includes("/founders") ||
      lowerUrl.includes("/governingboard") ||
      lowerUrl.includes("/directorsmessage") ||
      lowerUrl.includes("/ourhighlights") ||
      lowerUrl.includes("/organisational-") ||
      lowerUrl.includes("/careers") ||
      lowerUrl.includes("/management") ||
      lowerUrl.includes("/strength") ||
      lowerTitle.includes("organisational") ||
      lowerTitle.includes("governing board") ||
      lowerTitle.includes("founders") ||
      lowerTitle.includes("director") ||
      lowerTitle.includes("careers") ||
      lowerTitle.includes("management & faculty") ||
      lowerTitle.includes("strengths")
    ) {
      return;
    }

    if (!isUsefulTitle(title, sourceUrl)) return;
    const existing = candidatesMap.get(sourceUrl);
    if (existing) {
      if (!existing.advertisementUrl && advertisementUrl) {
        existing.advertisementUrl = advertisementUrl;
      }
    } else {
      candidatesMap.set(sourceUrl, { title, sourceUrl, advertisementUrl });
    }
  };

  $("tr").each((_index, element) => {
    const row = $(element);
    const links = row.find("a[href]");
    const rowPdfLinks: Array<{ url: string; label: string; title: string }> = [];
    const rowCandidates: Array<{ title: string; sourceUrl: string }> = [];

    links.each((_linkIndex, link) => {
      const anchor = $(link);
      const label = cleanText(anchor.text());
      const href = anchor.attr("href");

      if (!href) return;

      try {
        const url = new URL(href, IBPS_UPDATES_URL);
        if (!isAllowedHttpsUrl(url.href)) return;

        if (isPdfUrl(url.href)) {
          const title = cleanText(anchor.text() || anchor.attr("title") || "");
          rowPdfLinks.push({
            url: url.href,
            label: cleanText(`${title} ${href}`),
            title,
          });
          return;
        }

        if (isUsefulTitle(label)) {
          rowCandidates.push({ title: label, sourceUrl: url.href });
        }
      } catch {
        // Ignore malformed URLs.
      }
    });

    if (rowCandidates.length > 0) {
      const advertisementPdf =
        rowPdfLinks.find(({ label }) =>
          /advertisement|notification|detailed|advt|crp|recruitment|vacancy|information handout/i.test(
            label,
          ),
        ) ?? rowPdfLinks[0];

      for (const candidate of rowCandidates) {
        addCandidate(
          candidate.title,
          candidate.sourceUrl,
          advertisementPdf?.url,
        );
      }
    } else {
      for (const pdfLink of rowPdfLinks) {
        if (!isUsefulTitle(pdfLink.title)) continue;
        addCandidate(pdfLink.title, pdfLink.url, pdfLink.url);
      }
    }
  });

  if (candidatesMap.size === 0) {
    $("a[href]").each((_index, element) => {
      const anchor = $(element);
      const title = cleanText(anchor.text());
      const href = anchor.attr("href");

      if (!href) return;

      try {
        const url = new URL(href, IBPS_UPDATES_URL);
        if (!isAllowedHttpsUrl(url.href)) return;

        if (isUsefulTitle(title, url.href)) {
          if (isPdfUrl(url.href)) {
            addCandidate(title, url.href, url.href);
          } else {
            addCandidate(title, url.href);
          }
        }
      } catch {
        // Ignore malformed URLs.
      }
    });
  }

  const isLikelyPdf = (url?: string): boolean => {
    if (!url) return false;
    return isPdfUrl(url) || /\.pdf($|\?)/i.test(url);
  };

  const findBestPdfUrl = (params: {
    detailPage?: cheerio.CheerioAPI;
    baseUrl: string;
    sourceUrl: string;
    advertisementUrl?: string;
    pdfLinks?: Array<{ url: string; label?: string; title?: string }>;
  }): string | undefined => {
    const candidates: string[] = [];

    if (params.advertisementUrl) {
      candidates.push(params.advertisementUrl);
    }

    if (params.pdfLinks && params.pdfLinks.length > 0) {
      const preferred = params.pdfLinks.find((item) =>
        /advertisement|notification|detailed|advt|crp|recruitment|vacancy|corrigendum|information\s*handout|prospectus/i.test(
          `${item.label || ""} ${item.title || ""} ${item.url}`,
        ),
      );
      if (preferred?.url) candidates.push(preferred.url);
      for (const item of params.pdfLinks) {
        if (item.url) candidates.push(item.url);
      }
    }

    if (params.detailPage) {
      params.detailPage("a[href]").each((_idx, el) => {
        const anchor = params.detailPage!(el);
        const href = anchor.attr("href");
        if (!href) return;

        const meta = cleanText(
          `${anchor.text()} ${anchor.attr("title") || ""} ${href}`,
        );
        if (
          isLikelyPdf(href) ||
          /\b(pdf|notification|advertisement|advt|circular|prospectus|handout|corrigendum|brochure)\b/i.test(
            meta,
          )
        ) {
          candidates.push(href);
        }
      });
    }

    if (isLikelyPdf(params.sourceUrl)) {
      candidates.push(params.sourceUrl);
    }

    for (const raw of candidates) {
      const cleaned =
        sanitizeUrl(raw, params.baseUrl) ?? sanitizeUrl(raw, IBPS_UPDATES_URL);
      if (cleaned && isAllowedHttpsUrl(cleaned)) {
        return cleaned;
      }
    }

    return undefined;
  };

  const findNestedPdfUrl = async (
    detailPage: cheerio.CheerioAPI,
    baseUrl: string,
  ): Promise<string | undefined> => {
    const subPageUrls = new Set<string>();

    detailPage("a[href]").each((_idx, el) => {
      const anchor = detailPage(el);
      const href = anchor.attr("href");
      if (!href) return;

      const label = cleanText(`${anchor.text()} ${anchor.attr("title") || ""}`);
      const resolved =
        sanitizeUrl(href, baseUrl) ?? sanitizeUrl(href, IBPS_UPDATES_URL);
      if (!resolved || !isAllowedHttpsUrl(resolved) || isLikelyPdf(resolved)) {
        return;
      }

      if (
        /crp|recruitment|notification|advertisement|advt|vacancy|po\/mt|clerk|rrb|specialist|careers/i.test(
          `${label} ${resolved}`,
        )
      ) {
        subPageUrls.add(resolved);
      }
    });

    for (const subUrl of [...subPageUrls].slice(0, 3)) {
      try {
        const subHtml = await fetchText(subUrl);
        const subPage = cheerio.load(subHtml);
        subPage("script, style, noscript, svg").remove();
        const subPdfLinks = getPdfLinks(subPage, subUrl);

        const nestedPdf = findBestPdfUrl({
          detailPage: subPage,
          baseUrl: subUrl,
          sourceUrl: subUrl,
          pdfLinks: subPdfLinks,
        });

        if (nestedPdf) return nestedPdf;
      } catch {
        // Ignore unreachable sub-pages.
      }
    }

    return undefined;
  };

  const extractApplyOnlineFromPage = (
    detailPage: cheerio.CheerioAPI,
    baseUrl: string,
  ): string | undefined => {
    let foundApplyUrl: string | undefined;

    detailPage("a[href]").each((_idx, el) => {
      if (foundApplyUrl) return;
      const anchor = detailPage(el);
      const href = anchor.attr("href");
      const text = cleanText(
        `${anchor.text()} ${anchor.attr("title") || ""} ${href || ""}`,
      );

      if (
        !href ||
        !/apply\s*online|online\s*application|click\s*here\s*to\s*apply/i.test(
          text,
        )
      ) {
        return;
      }

      const sanitized = sanitizeUrl(href, baseUrl);
      if (sanitized && isAllowedHttpsUrl(sanitized) && !isLikelyPdf(sanitized)) {
        foundApplyUrl = sanitized;
      }
    });

    return foundApplyUrl;
  };

  const buildExamLinks = (params: {
    sourceUrl: string;
    notificationPdf?: string;
    admitCardUrl?: string;
    applyPageUrl?: string;
  }) => {
    const cleanSource =
      sanitizeUrl(params.sourceUrl, IBPS_UPDATES_URL) ?? IBPS_UPDATES_URL;
    const sourceIsPdf = isLikelyPdf(cleanSource);

    const cleanPdf =
      sanitizeUrl(params.notificationPdf, cleanSource) ??
      sanitizeUrl(params.notificationPdf, IBPS_UPDATES_URL) ??
      (sourceIsPdf ? cleanSource : "");

    const cleanApplyCandidate =
      sanitizeUrl(params.applyPageUrl, cleanSource) ??
      sanitizeUrl(params.applyPageUrl, IBPS_UPDATES_URL);

    const cleanApplyOnline =
      cleanApplyCandidate && !isLikelyPdf(cleanApplyCandidate)
        ? cleanApplyCandidate
        : !sourceIsPdf
          ? cleanSource
          : "https://www.ibps.in";

    const cleanAdmitCard =
      sanitizeUrl(params.admitCardUrl, cleanSource) ??
      sanitizeUrl(params.admitCardUrl, IBPS_UPDATES_URL);

    return {
      applyOnline: cleanApplyOnline,
      notificationPdf: cleanPdf,
      officialWebsite: "https://www.ibps.in",
      sourceUrl: cleanSource,
      ...(cleanAdmitCard ? { admitCardUrl: cleanAdmitCard } : {}),
    };
  };

  const cleanOverviewText = (text: string): string => {
    if (!text) return "";
    return text
      .replace(/^[\s\-–—_]+/, "")
      .replace(/[\s\-–—_]+$/, "")
      .replace(/[-–—]{3,}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const parseVacanciesData = (text: string): VacancyResult => {
    if (!text || typeof text !== "string") return { total: 0 };

    const normalized = normalizeScrapedText(text);
    let total = 0;

    const patterns = [
      /(?:total\s*(?:posts|vacancies|seats|number)?|number\s*of\s*vacancies|vacancies|posts)\s*(?:is|are|[:\s-])*\s*([\d,]{1,6})/i,
      /(\d{1,6})\s*(?:posts|vacancies|seats)\s*(?:are\s*available|total)?/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match && match[1]) {
        const parsed = parseInt(match[1].replace(/,/g, ""), 10);
        if (!isNaN(parsed) && parsed > 0) {
          total = parsed;
          break;
        }
      }
    }

    return { total };
  };

  const parseCategoryFees = (text: string): CategoryFeeResult => {
    const defaultFees = {
      general: 0,
      obc: 0,
      sc: 0,
      st: 0,
      ews: 0,
      pwd: 0,
      female: 0,
    };

    if (!text || typeof text !== "string") {
      return { applicationFee: 0, categoryWiseFee: defaultFees };
    }

    const normalized = normalizeScrapedText(text);
    let defaultFee = 0;

    const extractFeeFromSnippet = (snippet: string): number => {
      const match =
        snippet.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{2})?)/i) ||
        snippet.match(/\b([1-9]\d{2,4})\/-\b/);
      if (match && match[1]) {
        const parsed = parseInt(match[1].replace(/,/g, ""), 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
      return 0;
    };

    const groupPatterns = [
      {
        regex:
          /(?:sc\s*\/?\s*st\s*\/?\s*(?:pwd|pwbd))\s*[^\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i,
        targets: ["sc", "st", "pwd"],
      },
      {
        regex:
          /(?:general\s*\/?\s*obc\s*\/?\s*ews|all\s*other\s*categories?|other\s*than\s*sc)\s*[^\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i,
        targets: ["general", "obc", "ews"],
      },
      {
        regex:
          /(?:for\s*all\s*other)\s*[^\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i,
        targets: ["general", "obc", "ews"],
      },
    ];

    const fees = { ...defaultFees };
    for (const group of groupPatterns) {
      const match = normalized.match(group.regex);
      if (match && match[1]) {
        const feeVal = extractFeeFromSnippet(match[1]);
        if (feeVal > 0) {
          for (const target of group.targets) {
            fees[target as keyof typeof fees] = feeVal;
          }
        }
      }
    }

    const extractFeeFor = (keywords: string[]): number => {
      for (const kw of keywords) {
        const zeroRegex = new RegExp(
          `\\b${kw}\\b[^\\w]{0,30}\\b(nil|no\\s*fee|exempted|free|\\b0\\b)\\b`,
          "i",
        );
        if (zeroRegex.test(normalized)) return 0;

        const fwdRegex = new RegExp(
          `\\b${kw}\\b[^\\d]{0,35}(?:rs\\.?|inr|₹)?\\s*([\\d,]{2,5})`,
          "i",
        );
        const fwdMatch = normalized.match(fwdRegex);
        if (fwdMatch && fwdMatch[1]) {
          const parsed = parseInt(fwdMatch[1].replace(/,/g, ""), 10);
          if (!isNaN(parsed)) return parsed;
        }

        const bwdRegex = new RegExp(
          `(?:rs\\.?|inr|₹)?\\s*([\\d,]{2,5})[^\\d]{0,35}\\b${kw}\\b`,
          "i",
        );
        const bwdMatch = normalized.match(bwdRegex);
        if (bwdMatch && bwdMatch[1]) {
          const parsed = parseInt(bwdMatch[1].replace(/,/g, ""), 10);
          if (!isNaN(parsed)) return parsed;
        }
      }
      return 0;
    };

    if (fees.general === 0)
      fees.general = extractFeeFor(["general", "ur", "unreserved", "all other"]);
    if (fees.obc === 0)
      fees.obc = extractFeeFor(["obc", "other backward class", "bc"]);
    if (fees.ews === 0)
      fees.ews = extractFeeFor(["ews", "economically weaker"]);
    if (fees.sc === 0) fees.sc = extractFeeFor(["sc", "scheduled caste"]);
    if (fees.st === 0) fees.st = extractFeeFor(["st", "scheduled tribe"]);
    if (fees.pwd === 0)
      fees.pwd = extractFeeFor([
        "pwd",
        "pwbd",
        "handicapped",
        "benchmark disabilities",
      ]);
    if (fees.female === 0) fees.female = extractFeeFor(["female", "women"]);

    const generalFeeMatch = normalized.match(
      /(?:application fee|fee payable|examination fee|charges)[:\s-]*(?:rs\.?|inr|₹)?\s*([\d,]{2,5})/i,
    );
    if (generalFeeMatch && generalFeeMatch[1]) {
      defaultFee = parseInt(generalFeeMatch[1].replace(/,/g, ""), 10) || 0;
    }

    if (fees.general === 0) fees.general = defaultFee;
    if (fees.obc === 0) fees.obc = fees.general;
    if (fees.ews === 0) fees.ews = fees.general;

    const finalAppFee = defaultFee || fees.general;

    return {
      applicationFee: finalAppFee,
      categoryWiseFee: fees,
    };
  };

  const parseAgeLimitData = (
    text: string,
  ): { minAge: string; maxAge: string; relaxations?: string } => {
    const defaultAge = {
      minAge: "20",
      maxAge: "30",
      relaxations: "OBC: 3 Yrs, SC/ST: 5 Yrs",
    };
    if (!text || typeof text !== "string") return defaultAge;

    const normalized = normalizeScrapedText(text);
    let minAge = "";
    let maxAge = "";

    const rangeMatch = normalized.match(
      /(?:between\s*)?(\d{2})\s*(?:to|and|[-–])\s*(\d{2})\s*years?/i,
    );
    if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
      minAge = rangeMatch[1];
      maxAge = rangeMatch[2];
    }

    if (!minAge) {
      const minMatch = normalized.match(
        /(?:minimum\s*age|min\.?\s*age|not\s*less\s*than|not\s*below|above)\s*[:\s-]*(\d{1,2})\s*years?/i,
      );
      if (minMatch && minMatch[1]) {
        minAge = minMatch[1];
      }
    }

    if (!maxAge) {
      const maxMatch = normalized.match(
        /(?:maximum\s*age|max\.?\s*age|not\s*more\s*than|not\s*above|below|up\s*to)\s*[:\s-]*(\d{1,2})\s*years?/i,
      );
      if (maxMatch && maxMatch[1]) {
        maxAge = maxMatch[1];
      }
    }

    if (!minAge) minAge = "20";
    if (!maxAge) maxAge = "30";

    const relaxationMatch = normalized.match(
      /(?:age\s*relaxation|relaxation\s*of\s*upper\s*age|upper\s*age\s*limit\s*shall\s*be\s*relaxed)[^.]*\./i,
    );
    const relaxations = relaxationMatch
      ? relaxationMatch[0]
      : "OBC: 3 Yrs, SC/ST: 5 Yrs, PwD: 10 Yrs";

    return { minAge, maxAge, relaxations };
  };

  // Updated ONLY parseExamDate to parse Indian DD/MM/YYYY dates and schedule lines accurately
  const parseExamDate = (text: string): string => {
    if (!text || typeof text !== "string") return "To be announced";
    const normalized = normalizeScrapedText(text);

    const monthMap: Record<string, string> = {
      jan: "01",
      january: "01",
      feb: "02",
      february: "02",
      mar: "03",
      march: "03",
      apr: "04",
      april: "04",
      may: "05",
      jun: "06",
      june: "06",
      jul: "07",
      july: "07",
      aug: "08",
      august: "08",
      sep: "09",
      sept: "09",
      september: "09",
      oct: "10",
      october: "10",
      nov: "11",
      november: "11",
      dec: "12",
      december: "12",
    };

    const formatNumericDate = (
      dayStr: string,
      monthStr: string,
      yearStr: string,
    ): string | undefined => {
      const day = parseInt(dayStr, 10);
      const month = parseInt(monthStr, 10);
      let year = parseInt(yearStr, 10);
      if (year < 100) year += 2000;
      if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    };

    const parseDateCandidate = (raw: string): string | undefined => {
      const cleaned = raw
        .replace(/\b(st|nd|rd|th)\b/gi, "")
        .replace(/,/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const dmyNumeric = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
      if (dmyNumeric) {
        return formatNumericDate(dmyNumeric[1], dmyNumeric[2], dmyNumeric[3]);
      }

      const dmyNamed = cleaned.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/);
      if (dmyNamed) {
        const m = monthMap[dmyNamed[2].toLowerCase()];
        if (m) return formatNumericDate(dmyNamed[1], m, dmyNamed[3]);
      }

      const mdyNamed = cleaned.match(/^([a-zA-Z]+)\s+(\d{1,2})\s+(\d{4})$/);
      if (mdyNamed) {
        const m = monthMap[mdyNamed[1].toLowerCase()];
        if (m) return formatNumericDate(mdyNamed[2], m, mdyNamed[3]);
      }

      const parsed = Date.parse(cleaned);
      if (!isNaN(parsed)) {
        return new Date(parsed).toISOString().split("T")[0];
      }
      return undefined;
    };

    const dateTokenPattern =
      "\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[a-zA-Z]+\\s+\\d{4}|[a-zA-Z]+\\s+\\d{1,2}(?:st|nd|rd|th)?\\s+\\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{4}";

    const keywordRegex = new RegExp(
      `(?:exam(?:ination)?\\s*date|held\\s*on|tentative\\s*(?:exam(?:ination)?\\s*)?date|preliminary\\s*exam(?:ination)?|main(?:s)?\\s*exam(?:ination)?|single\\s*exam(?:ination)?|online\\s*exam(?:ination)?|schedule)[:\\s-]{0,45}(${dateTokenPattern})`,
      "i",
    );
    const keywordMatch = normalized.match(keywordRegex);

    if (keywordMatch && keywordMatch[1]) {
      const formatted = parseDateCandidate(keywordMatch[1]);
      if (formatted) return formatted;
      return keywordMatch[1].trim();
    }

    const generalDateMatch = normalized.match(
      /\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/,
    );
    if (generalDateMatch && generalDateMatch[1]) {
      const formatted = parseDateCandidate(generalDateMatch[1]);
      if (formatted) return formatted;
    }

    const monthYearMatch = normalized.match(
      /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*(?:to|-|\/)?\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)?\s*\d{4}/i,
    );
    if (monthYearMatch) {
      return monthYearMatch[0];
    }
    return "To be announced";
  };

  const extractEligibility = (
    text: string,
  ): { overview: string; qualification?: string } => {
    if (!text || typeof text !== "string") return { overview: "" };

    const normalized = normalizeScrapedText(text);
    const sentences = normalized.split(/(?<!\b[A-Z])(?<=[.?!])\s+/);

    const educationKeywords = [
      "degree",
      "graduation",
      "graduate",
      "post graduate",
      "post-graduate",
      "ug",
      "pg",
      "bachelor",
      "master",
      "discipline",
      "qualification",
      "eligibility",
    ];

    const matchedSentences: string[] = [];
    let detectedQualification = "Graduate Degree in any discipline";

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const isEduRelevant = educationKeywords.some((keyword) =>
        lower.includes(keyword),
      );

      if (isEduRelevant && sentence.length > 15) {
        matchedSentences.push(sentence.trim());

        if (/post\s*graduate|pg|master|doctorate|ph\.?d/i.test(lower)) {
          detectedQualification = "Postgraduate (PG) / Master's Degree";
        } else if (
          /under\s*graduate|ug|bachelor|graduat(e|ion)|degree/i.test(lower)
        ) {
          detectedQualification = "Undergraduate (UG) / Bachelor's Degree";
        }
      }
    }

    const overview =
      matchedSentences.length > 0
        ? matchedSentences.slice(0, 3).join(" ")
        : normalized.slice(0, 300);

    return {
      overview:
        typeof cleanOverviewText === "function"
          ? cleanOverviewText(overview)
          : overview,
      qualification: detectedQualification,
    };
  };

  const results = new Map<string, any>();

  for (const candidate of candidatesMap.values()) {
    let detailHtml = "";
    let aggregatedText = "";

    const fallbackPdfUrl = findBestPdfUrl({
      baseUrl: candidate.sourceUrl,
      sourceUrl: candidate.sourceUrl,
      advertisementUrl: candidate.advertisementUrl,
    });

    if (!isPdfUrl(candidate.sourceUrl)) {
      try {
        detailHtml = await fetchText(candidate.sourceUrl);
      } catch {
        const recruitmentId = crypto
          .createHash("sha256")
          .update(candidate.sourceUrl)
          .digest("hex");

        results.set(candidate.sourceUrl, {
          recruitmentId,
          title: candidate.title,
          org: "Institute of Banking Personnel Selection (IBPS)",
          sector: "BANKING",
          posts: "Not Announced",
          qualification: "Graduate Degree in any discipline",
          lastDate: "2026-12-31",
          fees: {
            generalObc: "850",
            scStPwdFemale: "175",
          },
          ageLimit: {
            minAge: "20",
            maxAge: "30",
            cutoffDate: "As per official notification",
            relaxations: "OBC: 3 Yrs, SC/ST: 5 Yrs",
          },
          links: buildExamLinks({
            sourceUrl: candidate.sourceUrl,
            notificationPdf: fallbackPdfUrl,
          }),
        });
        continue;
      }
    }

    const detailPage = cheerio.load(detailHtml);
    detailPage("script, style, noscript, svg").remove();

    const detailText = getDocumentText(detailPage);
    aggregatedText = normalizeScrapedText(`${aggregatedText} ${detailText}`);

    const pdfLinks = getPdfLinks(detailPage, candidate.sourceUrl);
    const admitCardUrl = getAdmitCardUrl(
      detailPage,
      candidate.sourceUrl,
      pdfLinks,
    );
    const applyPageUrl = detailHtml
      ? extractApplyOnlineFromPage(detailPage, candidate.sourceUrl)
      : undefined;

    const extractedFields = extractExamFields(aggregatedText);
    const eligibilityResult = extractEligibility(aggregatedText);

    let vacancyData = parseVacanciesData(
      extractSectionWindow(
        aggregatedText,
        /vacancy|vacancies|post|posts/i,
        600,
      ),
    );
    let feeData = parseCategoryFees(
      extractSectionWindow(
        aggregatedText,
        /application\s*fee|intimation\s*charges|fee\s*payable/i,
        600,
      ),
    );
    let ageData = parseAgeLimitData(
      extractSectionWindow(
        aggregatedText,
        /age\s*limit|upper\s*age|eligibility\s*criteria/i,
        600,
      ),
    );

    const advertisementPdf = candidate.advertisementUrl
      ? { url: candidate.advertisementUrl, label: "advertisement" }
      : pdfLinks.find(({ url, label }) =>
          /advertisement|notification|detailed|advt|crp|recruitment|information\s*handout/i.test(
            `${label} ${url}`,
          ),
        ) ?? pdfLinks[0];

    let resolvedNotificationPdf = findBestPdfUrl({
      detailPage: detailHtml ? detailPage : undefined,
      baseUrl: candidate.sourceUrl,
      sourceUrl: candidate.sourceUrl,
      advertisementUrl: advertisementPdf?.url ?? candidate.advertisementUrl,
      pdfLinks,
    });

    if (!resolvedNotificationPdf && detailHtml) {
      resolvedNotificationPdf = await findNestedPdfUrl(
        detailPage,
        candidate.sourceUrl,
      );
    }

    if (resolvedNotificationPdf) {
      const filename = `${crypto.createHash("sha256").update(resolvedNotificationPdf).digest("hex")}.pdf`;
      const absolutePath = path.join(UPLOAD_DIR, filename);

      try {
        await downloadPdf(resolvedNotificationPdf, absolutePath);

        const pdfBuffer = await fs.readFile(absolutePath);
        const parsed = await pdfParse(pdfBuffer);
        const pdfText = normalizeScrapedText(parsed.text ?? "");

        aggregatedText = normalizeScrapedText(`${aggregatedText} ${pdfText}`);

        const pdfFields = extractExamFields(pdfText);
        const pdfEligibility =
          typeof pdfFields.eligibility?.overview === "string" &&
          pdfFields.eligibility.overview.trim().length >= 20
            ? {
                overview: pdfFields.eligibility.overview.trim(),
                qualification: "Graduate Degree in any discipline",
              }
            : extractEligibility(pdfText);

        vacancyData = parseVacanciesData(
          extractSectionWindow(
            aggregatedText,
            /vacancy|vacancies|post|posts/i,
            600,
          ),
        );
        feeData = parseCategoryFees(
          extractSectionWindow(
            aggregatedText,
            /application\s*fee|intimation\s*charges|fee\s*payable/i,
            600,
          ),
        );
        ageData = parseAgeLimitData(
          extractSectionWindow(
            aggregatedText,
            /age\s*limit|upper\s*age|eligibility\s*criteria/i,
            600,
          ),
        );
        const extractedExamDate = parseExamDate(
          extractSectionWindow(
            aggregatedText,
            /schedule|examination|preliminary|main\s*exam|call\s*letter/i,
            600,
          ),
        );

        const finalEligibility = pdfEligibility.overview
          ? pdfEligibility
          : eligibilityResult;

        const applyEndStr = extractedFields.dates?.applicationEndDate
          ? new Date(extractedFields.dates.applicationEndDate)
              .toISOString()
              .split("T")[0]
          : "2026-12-31";

        const exam: any = {
          recruitmentId: crypto
            .createHash("sha256")
            .update(candidate.sourceUrl)
            .digest("hex"),
          title: candidate.title,
          org: "Institute of Banking Personnel Selection (IBPS)",
          sector: "BANKING",
          posts:
            vacancyData.total > 0 ? String(vacancyData.total) : "Not Announced",
          qualification:
            finalEligibility.qualification ||
            "Graduate Degree in any discipline",
          lastDate: applyEndStr,
          location: "All India",
          category: "Banking",
          status: "apply",
          featured: false,
          fees: {
            generalObc: String(feeData.categoryWiseFee.general || 850),
            scStPwdFemale: String(feeData.categoryWiseFee.sc || 175),
            paymentMode: "Online (UPI, Net Banking, Debit/Credit Card)",
          },
          ageLimit: {
            minAge: ageData.minAge,
            maxAge: ageData.maxAge,
            cutoffDate: "As per official notification",
            relaxations: ageData.relaxations,
          },
          links: buildExamLinks({
            sourceUrl: candidate.sourceUrl,
            notificationPdf: resolvedNotificationPdf,
            admitCardUrl,
            applyPageUrl,
          }),
          importantDates: {
            applyStart: extractedFields.dates?.applicationStartDate
              ? new Date(extractedFields.dates.applicationStartDate)
                  .toISOString()
                  .split("T")[0]
              : undefined,
            applyEnd: applyEndStr,
            examDate: extractedExamDate,
            admitCardDate: "4 Days before Exam",
            resultDate: "To be announced",
          },
        };

        results.set(candidate.sourceUrl, exam);
        continue;
      } catch (error) {
        console.error(`PDF processing failed for ${candidate.title}:`, error);
      }
    }

    const applyEndFallback = extractedFields.dates?.applicationEndDate
      ? new Date(extractedFields.dates.applicationEndDate)
          .toISOString()
          .split("T")[0]
      : "2026-12-31";

    const fallbackExamDate = parseExamDate(
      extractSectionWindow(
        aggregatedText,
        /schedule|examination|preliminary|main\s*exam|call\s*letter/i,
        600,
      ),
    );

    const exam: any = {
      recruitmentId: crypto
        .createHash("sha256")
        .update(candidate.sourceUrl)
        .digest("hex"),
      title: candidate.title,
      org: "Institute of Banking Personnel Selection (IBPS)",
      sector: "BANKING",
      posts:
        vacancyData.total > 0 ? String(vacancyData.total) : "Not Announced",
      qualification:
        eligibilityResult.qualification || "Graduate Degree in any discipline",
      lastDate: applyEndFallback,
      location: "All India",
      category: "Banking",
      status: "apply",
      featured: false,
      fees: {
        generalObc: String(feeData.categoryWiseFee.general || 850),
        scStPwdFemale: String(feeData.categoryWiseFee.sc || 175),
        paymentMode: "Online",
      },
      ageLimit: {
        minAge: ageData.minAge,
        maxAge: ageData.maxAge,
        cutoffDate: "As per official notification",
        relaxations: ageData.relaxations,
      },
      links: buildExamLinks({
        sourceUrl: candidate.sourceUrl,
        notificationPdf: resolvedNotificationPdf,
        admitCardUrl,
        applyPageUrl,
      }),
      importantDates: {
        applyEnd: applyEndFallback,
        examDate: fallbackExamDate,
      },
    };

    results.set(candidate.sourceUrl, exam);
  }

  let saved = 0;
  let dataChangesDetected = 0;

  for (const [sourceUrl, examData] of results.entries()) {
    const exam = examData as any;

    const resolvedLinks = buildExamLinks({
      sourceUrl: exam.links?.sourceUrl || sourceUrl,
      notificationPdf: exam.links?.notificationPdf,
      admitCardUrl: exam.links?.admitCardUrl,
      applyPageUrl: exam.links?.applyOnline,
    });

    const recruitmentId =
      exam.recruitmentId ||
      crypto
        .createHash("sha256")
        .update(resolvedLinks.sourceUrl)
        .digest("hex");

    const existingExam = await Exam.findOne({
      "links.sourceUrl": resolvedLinks.sourceUrl,
    });

    if (existingExam && existingExam.importantDates) {
      const oldDates = existingExam.importantDates;
      const newDates = exam.importantDates || {};

      if (
        oldDates.applyStart !== newDates.applyStart ||
        oldDates.applyEnd !== newDates.applyEnd ||
        oldDates.examDate !== newDates.examDate ||
        oldDates.admitCardDate !== newDates.admitCardDate ||
        oldDates.resultDate !== newDates.resultDate
      ) {
        dataChangesDetected++;

        console.warn(
          `[IBPS Schedule Update Detected] Exam: "${exam.title}"`,
        );
        console.log(
          `   - Old Exam Date: ${oldDates.examDate || "N/A"} -> New Exam Date: ${newDates.examDate || "N/A"}`,
        );
        console.log(
          `   - Old Last Date: ${oldDates.applyEnd || "N/A"} -> New Last Date: ${newDates.applyEnd || "N/A"}`,
        );
      }
    }

    await Exam.updateOne(
      { "links.sourceUrl": resolvedLinks.sourceUrl },
      {
        $set: {
          recruitmentId,
          title: exam.title,
          org: exam.org,
          sector: exam.sector,
          posts: exam.posts,
          qualification: exam.qualification,
          lastDate: exam.lastDate,
          location: exam.location,
          category: exam.category,
          status: exam.status,
          featured: exam.featured,
          fees: exam.fees,
          ageLimit: exam.ageLimit,
          links: resolvedLinks,
          importantDates: exam.importantDates,
          lastScrapedAt: new Date(),
        },
      },
      {
        upsert: true,
        runValidators: true,
      },
    );
    saved += 1;
  }

  return {
    found: results.size,
    saved,
    announcements: [...results.values()],
  };
};