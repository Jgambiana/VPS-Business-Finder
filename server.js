
require("dotenv").config({ path: __dirname + "/.env" });

const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
console.log("GOOGLE_API_KEY loaded?", !!GOOGLE_API_KEY);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, headers) {
  const headerLine = headers.map((h) => csvEscape(h.label)).join(",");
  const lines = rows.map((r) => headers.map((h) => csvEscape(r[h.key])).join(","));
  return [headerLine, ...lines].join("\r\n");
}

async function geocodeLocation(locationText) {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json?" +
    new URLSearchParams({
      address: locationText,
      key: GOOGLE_API_KEY,
    });

  const res = await fetch(url);
  const data = await res.json();

  if (!data.results || data.results.length === 0) return null;
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

async function placesTextSearchPaged({ query, lat, lng, radiusMeters, maxResults = 60 }) {
  let all = [];
  let pageToken = null;

  while (all.length < maxResults) {
    if (pageToken) await sleep(2000);

    const params = {
      query,
      location: `${lat},${lng}`,
      radius: String(radiusMeters),
      key: GOOGLE_API_KEY,
    };

    if (pageToken) params.pagetoken = pageToken;

    const url =
      "https://maps.googleapis.com/maps/api/place/textsearch/json?" +
      new URLSearchParams(params);

    const res = await fetch(url);
    const data = await res.json();

    const status = data.status || "UNKNOWN";
    if (status !== "OK" && status !== "ZERO_RESULTS") {
      throw new Error(`Places Text Search error: ${status} ${data.error_message || ""}`.trim());
    }

    const results = data.results || [];
    all = all.concat(results);

    pageToken = data.next_page_token;
    if (!pageToken || results.length === 0) break;
  }

  return all.slice(0, maxResults);
}

async function placeDetails(placeId) {
  const url =
    "https://maps.googleapis.com/maps/api/place/details/json?" +
    new URLSearchParams({
      place_id: placeId,
      fields: [
        "name",
        "formatted_address",
        "formatted_phone_number",
        "international_phone_number",
        "website",
        "url",
        "rating",
        "user_ratings_total"
      ].join(","),
      key: GOOGLE_API_KEY,
    });

  const res = await fetch(url);
  const data = await res.json();

  if ((data.status || "UNKNOWN") !== "OK") return { result: null };
  return data;
}

function extractEmailsFromText(text) {
  if (!text) return [];
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const cleaned = matches
    .map((e) => e.trim().replace(/[),.;:]+$/g, ""))
    .filter((e) => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(e));
  return [...new Set(cleaned)];
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

async function fetchHtml(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "VPSBusinessFinder/1.0",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("text/html")) return null;

    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeEmailsFromWebsite(websiteUrl) {
  const base = normalizeUrl(websiteUrl);
  if (!base) return { emails: [], bestEmail: "" };

  const candidateUrls = new Set([
    base,
    new URL("/contact", base).toString(),
    new URL("/contact-us", base).toString(),
    new URL("/about", base).toString(),
    new URL("/about-us", base).toString(),
  ]);

  const allEmails = new Set();
  const visited = new Set();

  async function processPage(url) {
    if (!url || visited.has(url) || !sameHost(base, url)) return;
    visited.add(url);

    const html = await fetchHtml(url);
    if (!html) return;

    extractEmailsFromText(html).forEach((e) => allEmails.add(e));

    const $ = cheerio.load(html);

    $("a[href^='mailto:']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const email = href.replace(/^mailto:/i, "").split("?")[0].trim();
      if (email) allEmails.add(email);
    });

    $("a").each((_, el) => {
      const text = ($(el).text() || "").toLowerCase().trim();
      const href = $(el).attr("href") || "";

      if (
        text.includes("contact") ||
        text.includes("about") ||
        href.toLowerCase().includes("contact") ||
        href.toLowerCase().includes("about")
      ) {
        try {
          const nextUrl = new URL(href, base).toString();
          if (sameHost(base, nextUrl)) {
            candidateUrls.add(nextUrl);
          }
        } catch {}
      }
    });
  }

  const initial = [...candidateUrls].slice(0, 5);
  for (const url of initial) {
    await processPage(url);
  }

  const discovered = [...candidateUrls].slice(0, 8);
  for (const url of discovered) {
    await processPage(url);
  }

  const list = [...allEmails];

  const preferredPrefixes = ["info@", "sales@", "support@", "contact@", "hello@", "office@", "admin@"];
  const bestEmail =
    list.find((e) => preferredPrefixes.some((p) => e.toLowerCase().startsWith(p))) ||
    list[0] ||
    "";

  return { emails: list, bestEmail };
}

async function mapLimit(items, limit, asyncFn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await asyncFn(items[currentIndex], currentIndex);
      } catch (err) {
        console.error("mapLimit item error:", err.message || err);
        results[currentIndex] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function buildResults({ location, businessType, radiusMiles = 10, maxResults = 60, scrapeEmails = true }) {
  if (!GOOGLE_API_KEY) throw new Error("Missing GOOGLE_API_KEY on server (check Backend/.env)");
  if (!location || !businessType) throw new Error("location and businessType are required");

  const geo = await geocodeLocation(location);
  if (!geo) throw new Error("Could not geocode location");

  const radiusMeters = Math.min(Math.round(Number(radiusMiles) * 1609.34), 50000);
  const query = `${businessType} in ${location}`;

  const places = await placesTextSearchPaged({
    query,
    lat: geo.lat,
    lng: geo.lng,
    radiusMeters,
    maxResults: Math.min(Number(maxResults) || 60, 120),
  });

  const uniquePlaces = [];
  const seen = new Set();

  for (const p of places) {
    const key = p.place_id || `${p.name}|${p.formatted_address}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniquePlaces.push(p);
    }
  }

  const detailed = await mapLimit(uniquePlaces, 6, async (p) => {
    const details = await placeDetails(p.place_id);
    const r = details.result;

    let emails = [];
    let bestEmail = "";

    const website = (r && r.website) || "";
    if (scrapeEmails && website) {
      const emailData = await scrapeEmailsFromWebsite(website);
      emails = emailData.emails;
      bestEmail = emailData.bestEmail || "";
    }

    return {
      name: (r && r.name) || p.name || "",
      phone: (r && (r.formatted_phone_number || r.international_phone_number)) || "",
      address: (r && r.formatted_address) || p.formatted_address || "",
      website,
      googleMapsUrl: (r && r.url) || "",
      rating: (r && r.rating) || "",
      reviewCount: (r && r.user_ratings_total) || "",
      lat: (p.geometry && p.geometry.location && p.geometry.location.lat) || "",
      lng: (p.geometry && p.geometry.location && p.geometry.location.lng) || "",
      email: bestEmail,
      allEmails: emails.join("; "),
    };
  });

  return {
    query,
    geo,
    results: detailed.filter(Boolean),
  };
}

app.get("/health", (req, res) => res.send("ok"));

app.post("/api/search", async (req, res) => {
  try {
    const {
      location,
      businessType,
      radiusMiles = 10,
      maxResults = 60,
      scrapeEmails = true
    } = req.body;

    const data = await buildResults({
      location,
      businessType,
      radiusMiles,
      maxResults,
      scrapeEmails
    });

    res.json({
      query: data.query,
      location: { input: location, lat: data.geo.lat, lng: data.geo.lng },
      count: data.results.length,
      results: data.results,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/search.csv", async (req, res) => {
  try {
    const {
      location,
      businessType,
      radiusMiles = 10,
      maxResults = 60,
      scrapeEmails = true
    } = req.body;

    const data = await buildResults({
      location,
      businessType,
      radiusMiles,
      maxResults,
      scrapeEmails
    });

    const headers = [
      { label: "Name", key: "name" },
      { label: "Phone", key: "phone" },
      { label: "Address", key: "address" },
      { label: "Website", key: "website" },
      { label: "Email", key: "email" },
      { label: "All Emails", key: "allEmails" },
      { label: "Rating", key: "rating" },
      { label: "Review Count", key: "reviewCount" },
      { label: "Google Maps URL", key: "googleMapsUrl" },
      { label: "Latitude", key: "lat" },
      { label: "Longitude", key: "lng" },
    ];

    const csv = toCsv(data.results, headers);

    const safeLocation = String(location).replace(/[^\w-]+/g, "_").slice(0, 40);
    const safeType = String(businessType).replace(/[^\w-]+/g, "_").slice(0, 40);
    const filename = `business_finder_${safeType}_${safeLocation}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});


app.listen(3000, () => console.log("Server running on http://127.0.0.1:3000"));

