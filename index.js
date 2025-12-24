import express from "express";
import yahooFinance from "yahoo-finance2";
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
 * Fetches detailed financial metrics for a given stock symbol using yahoo-finance2.
 * Includes robust data extraction with optional chaining to prevent crashes from missing data fields.
 * @param {string} stockSymbol - The stock ticker symbol (e.g., "TCS", "MSFT").
 * @returns {Promise<object>} An object containing key financial metrics.
 */
async function getStockMetrics(stockSymbol) {
  try {
    const quote = await yahooFinance.quote(stockSymbol);
    const financials = await yahooFinance.quoteSummary(stockSymbol, {
      modules: ["financialData", "summaryDetail", "defaultKeyStatistics", "price"],
    });

    // Consolidate data, using optional chaining (?.) and nullish coalescing (??) for safety.
    return {
      stockName: quote?.shortName ?? 'N/A',
      symbol: quote?.symbol ?? stockSymbol,
      currentPrice: quote?.regularMarketPrice ?? 0,
      dayHigh: quote?.regularMarketDayHigh ?? 0,
      dayLow: quote?.regularMarketDayLow ?? 0,
      peRatio: financials?.summaryDetail?.trailingPE ?? 0,
      roe: financials?.defaultKeyStatistics?.returnOnEquity ?? 0,
      debtToEquity: financials?.financialData?.debtToEquity ?? 0,
      profitMargins: (financials?.financialData?.profitMargins ?? 0) * 100,
      revenueGrowth: (financials?.financialData?.revenueGrowth ?? 0) * 100,
    };
  } catch (error) {
    console.error(`Error fetching data for symbol ${stockSymbol}:`, error.message);
    // Rethrow error to be caught by the API endpoint handler
    throw new Error(`Failed to retrieve data for symbol ${stockSymbol}. Check if the symbol is valid.`);
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

    const prompt = `Analyze ${stockData.stockName} (${symbol}) stock based on these financial metrics:
Provide a recommendation (Buy / Sell / Hold) in ONE word only on the first line.
On the next line, give a confidence percentage (e.g., "Confidence: 85%").`;

    const result = await model.generateContent(prompt);
    const geminiResponse = result.response.text();

    res.json({ geminiResponse });
  } catch (error) {
    console.error("Gemini Error or data fetch error during analysis:", error);
    res.status(500).json({ error: "AI analysis failed." });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});