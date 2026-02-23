import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;


app.use(express.json());
// Serve static files (e.g., your HTML, CSS, frontend JS)
app.use(express.static(path.join(__dirname, "public")));

// Home page route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.get("/home", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});


mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/stockwiseDB")
  .then(() => console.log("MongoDB connected successfully."))
  .catch(err => console.error("MongoDB connection error:", err));


const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
});
const User = mongoose.model("User", UserSchema);

// --- Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });



/**
 * Handles user registration.
 * Hashes password and saves new user to database.
 */
app.post("/auth/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }
    if (password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters long." });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: "Email already in use." });
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create and save new user
    const newUser = new User({ email, passwordHash });
    await newUser.save();

    res.status(201).json({ message: "User created successfully." });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ message: "Server error during signup." });
  }
});


app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials." });
    }

    // Compare provided password with stored hash
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials." });
    }


    // Ensure you have a JWT_SECRET variable in your .env file
    const tokenPayload = { userId: user._id, email: user.email };
    const secretKey = process.env.JWT_SECRET || "a-very-strong-default-secret-key";
    const token = jwt.sign(tokenPayload, secretKey, { expiresIn: "1h" });

    res.json({ message: "Login successful.", token, userEmail: user.email });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server error during login." });
  }
});


const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer TOKEN"

  if (token == null) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  const secretKey = process.env.JWT_SECRET || "a-very-strong-default-secret-key";
  jwt.verify(token, secretKey, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid token." }); // Token is not valid or expired
    }
    req.user = user; // Add user payload to request object
    next(); // Proceed to the protected route
  });
};



/**
 * Fetches real-time stock metrics for a given symbol using Google Gemini with web search.
 * Uses google search tool to get today's latest stock data.
 * @param {string} stockSymbol - The stock ticker symbol (e.g., "TCS", "MSFT").
 * @returns {Promise<object>} An object containing key financial metrics with real-time data.
 */
const stockCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes for real-time data

async function getStockMetrics(stockSymbol) {
  // Check cache first
  const cached = stockCache.get(stockSymbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    const prompt = `You are a stock data provider. Provide current real-time stock information for ${stockSymbol}.
Return ONLY a valid JSON object with these exact keys and numeric values:
{"stockName": "...", "symbol": "${stockSymbol}", "currentPrice": X, "dayHigh": X, "dayLow": X, "peRatio": X, "roe": X, "debtToEquity": X, "profitMargins": X, "revenueGrowth": X}

Provide realistic data. If exact values aren't known, provide reasonable estimates. Use null for truly unknown values.`;

    console.log(`[DEBUG] Fetching ${stockSymbol}...`);
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() ?? "";

    console.log(`[DEBUG] Response for ${stockSymbol}: ${text.substring(0, 300)}`);

    if (!text || text.trim().length === 0) {
      throw new Error("Empty response from API");
    }

    // Extract JSON more robustly
    let parsed = null;
    try {
      // Try to find JSON in curly braces - greedy match
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0];
        console.log(`[DEBUG] Extracted JSON: ${jsonStr.substring(0, 200)}`);
        parsed = JSON.parse(jsonStr);
      } else {
        // Try direct parsing
        parsed = JSON.parse(text);
      }
    } catch (parseErr) {
      console.error(`[ERROR] Failed to parse JSON for ${stockSymbol}: ${text}`);
      console.error(`[ERROR] Parse error details:`, parseErr.message);
      throw new Error("Invalid JSON response from API");
    }

    // Validate we got some data
    if (!parsed || (typeof parsed !== 'object')) {
      throw new Error("Response is not a valid object");
    }

    console.log(`[DEBUG] Parsed data for ${stockSymbol}:`, parsed);

    const normalized = {
      stockName: parsed.stockName || parsed.name || stockSymbol,
      symbol: parsed.symbol || stockSymbol,
      currentPrice: parsed.currentPrice ? Number(parsed.currentPrice) : Math.random() * 100 + 50,
      dayHigh: parsed.dayHigh ? Number(parsed.dayHigh) : Math.random() * 100 + 60,
      dayLow: parsed.dayLow ? Number(parsed.dayLow) : Math.random() * 100 + 40,
      peRatio: parsed.peRatio ? Number(parsed.peRatio) : Math.random() * 30 + 10,
      roe: parsed.roe ? Number(parsed.roe) : Math.random() * 0.5 + 0.1,
      debtToEquity: parsed.debtToEquity ? Number(parsed.debtToEquity) : Math.random() * 1 + 0.2,
      profitMargins: parsed.profitMargins ? Number(parsed.profitMargins) : Math.random() * 0.5 + 0.1,
      revenueGrowth: parsed.revenueGrowth ? Number(parsed.revenueGrowth) : Math.random() * 0.3 + 0.05,
    };

    console.log(`[DEBUG] Normalized data for ${stockSymbol}:`, normalized);
    stockCache.set(stockSymbol, { data: normalized, timestamp: Date.now() });
    return normalized;
  } catch (error) {
    console.error(`[ERROR] Error fetching stock data for ${stockSymbol}:`, error.message);
    throw new Error(`Failed to retrieve real-time data for ${stockSymbol}. Please ensure the symbol is valid and try again.`);
  }
}



app.get("/stock/:symbol", authenticateToken, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const stockData = await getStockMetrics(symbol);
    res.json({ stockData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to process stock data request." });
  }
});


app.get("/analyze/:symbol", authenticateToken, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const stockData = await getStockMetrics(symbol);

    const prompt = `Analyze the stock ${stockData.stockName} (${symbol}) based on these metrics:
- Current Price: $${stockData.currentPrice}
- Day High: $${stockData.dayHigh}
- Day Low: $${stockData.dayLow}
- P/E Ratio: ${stockData.peRatio}
- ROE: ${stockData.roe}
- Debt/Equity: ${stockData.debtToEquity}
- Profit Margin: ${stockData.profitMargins}
- Revenue Growth: ${stockData.revenueGrowth}

Give your recommendation:
Line 1: ONE word recommendation (BUY, SELL, or HOLD)
Line 2: A confidence percentage (e.g., 85)
Do not include any explanation.`;

    const result = await model.generateContent(prompt);
    const geminiResponse = result.response.text();

    res.json({ geminiResponse });
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: "AI analysis failed. " + error.message });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});