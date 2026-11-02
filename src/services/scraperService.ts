
import { execFile } from "node:child_process";
import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Exam from "../models/examModel";
import env from "../config/env";
import { CategoryFeeResult, ScraperResult, VacancyResult } from "../Types/scraperServiceType";

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
    if (
      sourceUrl.includes('/services') || 
      sourceUrl.includes('/gallery') || 
      sourceUrl.includes('/contact-us') ||
      sourceUrl.includes('/about-us') ||
      sourceUrl.includes('/chairmen') ||
      sourceUrl.includes('/founders') ||
      sourceUrl.includes('/governingboard') ||
      sourceUrl.includes('/directorsmessage') ||
      sourceUrl.includes('/ourhighlights') ||
      sourceUrl.includes('/organisational-') ||
      lowerTitle.includes('organisational') ||
      lowerTitle.includes('governing board') ||
      lowerTitle.includes('founders') ||
      lowerTitle.includes('director')
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

    const cleanText = text.replace(/\s+/g, " ");
    let total = 0;

    const patterns = [
      /(?:total\s*(?:posts|vacancies|seats|number)?|number\s*of\s*vacancies|vacancies|posts)\s*(?:is|are|[:\s-])*\s*([\d,]{1,6})/i,
      /(\d{1,6})\s*(?:posts|vacancies|seats)\s*(?:are\s*available|total)?/i
    ];

    for (const pattern of patterns) {
      const match = cleanText.match(pattern);
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
    const defaultFees = { general: 0, obc: 0, sc: 0, st: 0, ews: 0, pwd: 0, female: 0 };
    
    if (!text || typeof text !== "string") {
      return { applicationFee: 0, categoryWiseFee: defaultFees };
    }

    const cleanText = text.replace(/\s+/g, " ");
    let defaultFee = 0;

    const extractFeeFromSnippet = (snippet: string): number => {
      const match = snippet.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{2})?)/i) || snippet.match(/\b([1-9]\d{2,4})\/-\b/);
      if (match && match[1]) {
        const parsed = parseInt(match[1].replace(/,/g, ""), 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
      return 0;
    };

    const groupPatterns = [
      { 
        regex: /(?:sc\s*\/?\s*st\s*\/?\s*(?:pwd|pwbd))\s*[^\\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i, 
        targets: ['sc', 'st', 'pwd'] 
      },
      { 
        regex: /(?:general\s*\/?\s*obc\s*\/?\s*ews|all\s*other\s*categories?|other\s*than\s*sc)\s*[^\\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i, 
        targets: ['general', 'obc', 'ews'] 
      },
      { 
        regex: /(?:for\s*all\s*other)\s*[^\\d]{0,30}((?:rs\.?|inr|₹)?\s*[\d,]+(?:\/)?)/i, 
        targets: ['general', 'obc', 'ews'] 
      }
    ];

    const fees = { ...defaultFees };
    for (const group of groupPatterns) {
      const match = cleanText.match(group.regex);
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
        const zeroRegex = new RegExp(`\\b${kw}\\b[^\\w]{0,30}\\b(nil|no\\s*fee|exempted|free|\\b0\\b)\\b`, "i");
        if (zeroRegex.test(cleanText)) return 0;

        const fwdRegex = new RegExp(`\\b${kw}\\b[^\\d]{0,35}(?:rs\\.?|inr|₹)?\\s*([\\d,]{2,5})`, "i");
        const fwdMatch = cleanText.match(fwdRegex);
        if (fwdMatch && fwdMatch[1]) {
          const parsed = parseInt(fwdMatch[1].replace(/,/g, ""), 10);
          if (!isNaN(parsed)) return parsed;
        }

        const bwdRegex = new RegExp(`(?:rs\\.?|inr|₹)?\\s*([\\d,]{2,5})[^\\d]{0,35}\\b${kw}\\b`, "i");
        const bwdMatch = cleanText.match(bwdRegex);
        if (bwdMatch && bwdMatch[1]) {
          const parsed = parseInt(bwdMatch[1].replace(/,/g, ""), 10);
          if (!isNaN(parsed)) return parsed;
        }
      }
      return 0;
    };

    if (fees.general === 0) fees.general = extractFeeFor(["general", "ur", "unreserved", "all other"]);
    if (fees.obc === 0) fees.obc = extractFeeFor(["obc", "other backward class", "bc"]);
    if (fees.ews === 0) fees.ews = extractFeeFor(["ews", "economically weaker"]);
    if (fees.sc === 0) fees.sc = extractFeeFor(["sc", "scheduled caste"]);
    if (fees.st === 0) fees.st = extractFeeFor(["st", "scheduled tribe"]);
    if (fees.pwd === 0) fees.pwd = extractFeeFor(["pwd", "pwbd", "handicapped", "benchmark disabilities"]);
    if (fees.female === 0) fees.female = extractFeeFor(["female", "women"]);

    const generalFeeMatch = cleanText.match(/(?:application fee|fee payable|examination fee|charges)[:\s-]*(?:rs\.?|inr|₹)?\s*([\\d,]{2,5})/i);
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

  const extractEligibility = (text: string): { overview: string; qualification?: string } => {
    if (!text) return { overview: "" };

    const cleanedText = text.replace(/\s+/g, " ");
    const sentences = cleanedText.split(/(?<=[.?!])\s+/);
    
    const educationKeywords = [
      "degree", "graduation", "graduate", "post graduate", "post-graduate",
      "ug", "pg", "bachelor", "master", "discipline", "qualification"
    ];

    const matchedSentences: string[] = [];
    let detectedQualification = "Graduate Degree in any discipline";

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const isEduRelevant = educationKeywords.some((keyword) => lower.includes(keyword));
      
      if (isEduRelevant && sentence.length > 15) {
        matchedSentences.push(sentence.trim());
        
        if (/post\s*graduate|pg|master/i.test(lower)) {
          detectedQualification = "Postgraduate (PG) / Master's Degree";
        } else if (/under\s*graduate|ug|bachelor|graduat(e|ion)|degree/i.test(lower)) {
          detectedQualification = "Undergraduate (UG) / Bachelor's Degree";
        }
      }
    }

    const overview = matchedSentences.length > 0 
      ? matchedSentences.slice(0, 3).join(" ") 
      : cleanedText.slice(0, 300);

    return {
      overview: cleanOverviewText(overview),
      qualification: detectedQualification
    };
  };

  const results = new Map<string, any>();

  for (const candidate of candidatesMap.values()) {
    let detailHtml = "";
    let aggregatedText = "";

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
            scStPwdFemale: "175"
          },
          ageLimit: {
            minAge: "20",
            maxAge: "30"
          },
          links: {
            applyOnline: candidate.sourceUrl,
            officialWebsite: "https://www.ibps.in",
            sourceUrl: candidate.sourceUrl,
          },
        });
        continue;
      }
    }

    const detailPage = cheerio.load(detailHtml);
    detailPage("script, style, noscript, svg").remove();

    const detailText = getDocumentText(detailPage);
    aggregatedText += " " + detailText;

    const pdfLinks = getPdfLinks(detailPage, candidate.sourceUrl);
    const admitCardUrl = getAdmitCardUrl(detailPage, candidate.sourceUrl, pdfLinks);
    const extractedFields = extractExamFields(aggregatedText);
    const eligibilityResult = extractEligibility(aggregatedText);
    
    let vacancyData = parseVacanciesData(aggregatedText);
    let feeData = parseCategoryFees(aggregatedText);

    let advertisementPdf = candidate.advertisementUrl
      ? { url: candidate.advertisementUrl, label: "advertisement" }
      : pdfLinks.find(({ url, label }) =>
          /advertisement|notification|detailed|advt|crp|recruitment|information\s*handout/i.test(
            `${label} ${url}`,
          ),
        );

    if (!advertisementPdf && pdfLinks.length > 0) {
      advertisementPdf = pdfLinks[0];
    }

    if (advertisementPdf) {
      const advertisementUrl = advertisementPdf.url;
      const filename = `${crypto.createHash("sha256").update(advertisementUrl).digest("hex")}.pdf`;
      const absolutePath = path.join(UPLOAD_DIR, filename);

      try {
        await downloadPdf(advertisementUrl, absolutePath);

        const pdfBuffer = await fs.readFile(absolutePath);
        const parsed = await pdfParse(pdfBuffer);
        const pdfText = parsed.text ?? "";
        
        aggregatedText += " " + pdfText;

        const pdfFields = extractExamFields(pdfText);
        const pdfEligibility = 
        typeof pdfFields.eligibility?.overview === "string" &&
        pdfFields.eligibility.overview.trim().length >= 20
          ? { overview: pdfFields.eligibility.overview.trim(), qualification: "Graduate Degree in any discipline" }
          : extractEligibility(pdfText);

        vacancyData = parseVacanciesData(aggregatedText);
        feeData = parseCategoryFees(aggregatedText);

        const finalEligibility = pdfEligibility.overview ? pdfEligibility : eligibilityResult;

        const applyEndStr = extractedFields.dates?.applicationEndDate 
          ? new Date(extractedFields.dates.applicationEndDate).toISOString().split('T')[0]
          : "2026-12-31";

        const exam: any = {
          recruitmentId: crypto
            .createHash("sha256")
            .update(candidate.sourceUrl)
            .digest("hex"),
          title: candidate.title,
          org: "Institute of Banking Personnel Selection (IBPS)",
          sector: "BANKING",
          posts: vacancyData.total > 0 ? String(vacancyData.total) : "Not Announced",
          qualification: finalEligibility.qualification || "Graduate Degree in any discipline",
          lastDate: applyEndStr,
          location: "All India",
          category: "Banking",
          status: "apply",
          featured: false,
          fees: {
            generalObc: String(feeData.categoryWiseFee.general || 850),
            scStPwdFemale: String(feeData.categoryWiseFee.sc || 175),
            paymentMode: "Online (UPI, Net Banking, Debit/Credit Card)"
          },
          ageLimit: {
            minAge: "20",
            maxAge: "30",
            relaxations: "OBC 3 Years, SC/ST 5 Years as per rules"
          },
          links: {
            applyOnline: candidate.sourceUrl,
            notificationPdf: advertisementUrl,
            officialWebsite: "https://www.ibps.in",
            sourceUrl: candidate.sourceUrl,
          },
          importantDates: {
            applyStart: extractedFields.dates?.applicationStartDate ? new Date(extractedFields.dates.applicationStartDate).toISOString().split('T')[0] : undefined,
            applyEnd: applyEndStr,
            examDate: extractedFields.dates?.examDateStart ? new Date(extractedFields.dates.examDateStart).toISOString().split('T')[0] : "To be announced",
            admitCardDate: admitCardUrl || "4 Days before Exam",
            resultDate: "To be announced"
          }
        };

        results.set(candidate.sourceUrl, exam);
        continue;
      } catch (error) {
        console.error(`PDF processing failed for ${candidate.title}:`, error);
      }
    }

    const applyEndFallback = extractedFields.dates?.applicationEndDate 
      ? new Date(extractedFields.dates.applicationEndDate).toISOString().split('T')[0]
      : "2026-12-31";

    const exam: any = {
      recruitmentId: crypto
        .createHash("sha256")
        .update(candidate.sourceUrl)
        .digest("hex"),
      title: candidate.title,
      org: "Institute of Banking Personnel Selection (IBPS)",
      sector: "BANKING",
      posts: vacancyData.total > 0 ? String(vacancyData.total) : "Not Announced",
      qualification: eligibilityResult.qualification || "Graduate Degree in any discipline",
      lastDate: applyEndFallback,
      location: "All India",
      category: "Banking",
      status: "apply",
      featured: false,
      fees: {
        generalObc: String(feeData.categoryWiseFee.general || 850),
        scStPwdFemale: String(feeData.categoryWiseFee.sc || 175),
        paymentMode: "Online"
      },
      ageLimit: {
        minAge: "20",
        maxAge: "30",
        relaxations: "OBC 3 Years, SC/ST 5 Years as per rules"
      },
      links: {
        applyOnline: candidate.sourceUrl,
        notificationPdf: candidate.advertisementUrl || "",
        officialWebsite: "https://www.ibps.in",
        sourceUrl: candidate.sourceUrl,
      },
      importantDates: {
        applyEnd: applyEndFallback,
        examDate: "To be announced"
      }
    };

    results.set(candidate.sourceUrl, exam);
  }

  let saved = 0;

  for (const [sourceUrl, examData] of results.entries()) {
    const exam = examData as any;

    const validSourceUrl = sourceUrl || exam.links?.sourceUrl || exam.title;
    const recruitmentId = exam.recruitmentId || crypto
      .createHash("sha256")
      .update(validSourceUrl)
      .digest("hex");

    await Exam.updateOne(
      { "links.sourceUrl": sourceUrl },
      {
        $set: {
          recruitmentId, // Ensure recruitmentId is always updated/set and never null
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
          links: exam.links,
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