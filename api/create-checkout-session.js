const Stripe = require("stripe");
const { google } = require("googleapis");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const ALLOWED_TIMES = ["18:30", "20:30"]; // 6:30pm, 8:30pm
const ALLOWED_DAYS = [4, 5, 6]; // Thu=4, Fri=5, Sat=6
const MAX_PER_SLOT = 5;

function getGoogleClient() {
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY || "";
  const normalized = rawKey.replace(/\\n/g, "\n").replace(/\r/g, "").trim();
  const privateKey = normalized.includes("BEGIN PRIVATE KEY")
    ? normalized
    : Buffer.from(normalized, "base64").toString("utf8");
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
  return google.sheets({ version: "v4", auth });
}

async function countReservations(date, time) {
  const sheets = getGoogleClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${process.env.GOOGLE_SHEETS_SHEET_NAME}!A:Z`
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return 0;

  const startIndex =
    rows[0] && rows[0].some((cell) => String(cell).toLowerCase().includes("date"))
      ? 1
      : 0;

  let count = 0;
  for (let i = startIndex; i < rows.length; i += 1) {
    const row = rows[i];
    const rowDate = row[3];
    const rowTime = row[4];
    if (rowDate === date && rowTime === time) {
      count += 1;
    }
  }

  return count;
}

function isAllowedDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getDay();
  return ALLOWED_DAYS.includes(day);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  const allowed = new Set(["https://per-due.la", "https://www.per-due.la"]);
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const rawBody = await readRawBody(req);
  let body = {};
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { name, email, date, time, partySize, celebration } = body || {};

  if (!name || !email || !date || !time || !partySize) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const party = Number(partySize);
  if (party !== 2) {
    return res.status(400).json({ error: "Party size must be 2" });
  }

  if (!isAllowedDate(date)) {
    return res.status(400).json({ error: "Date must be Thu, Fri, or Sat" });
  }

  if (!ALLOWED_TIMES.includes(time)) {
    return res.status(400).json({ error: "Time must be 18:30 or 20:30" });
  }

  const currentCount = await countReservations(date, time);
  if (currentCount >= MAX_PER_SLOT) {
    return res.status(409).json({ error: "That time slot is fully booked." });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Reservation Deposit",
            description: "per due (x2 guests)"
          },
          unit_amount: 5000
        },
        quantity: 1
      }
    ],
    metadata: { name, date, time, partySize: String(party), celebration: celebration || "" },
    success_url: `${process.env.BASE_URL}/reservation-confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.BASE_URL}/reservation-canceled`
  });

  res.status(200).json({ url: session.url });
};
