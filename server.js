// Tiny movie helper API: prefers clarity over cleverness.

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

dotenv.config();

const REQUIRED_KEYS = ["TMDB_KEY", "BEDROCK_MODEL_ID"];
const MOCK_MODE = process.env.MOCK_BEDROCK === "true";
const missingKeys = REQUIRED_KEYS.filter(key => !process.env[key]);

if (missingKeys.length && !MOCK_MODE) {
  throw new Error(`Missing .env values: ${missingKeys.join(", ")}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_PREFS = {
  genres: ["sci-fi", "thriller"],
  mood: "mind-bending but not too dark",
  yearRange: [2005, 2025],
  language: "en",
  avoid: ["horror"]
};

// Friendly genre names mapped to TMDB IDs (only the ones we need).
const GENRES = {
  action: 28,
  adventure: 12,
  comedy: 35,
  drama: 18,
  horror: 27,
  romance: 10749,
  thriller: 53,
  "sci-fi": 878
};

const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || "us-east-1"
});

const toCsv = list => {
  const ids = (list || []).map(name => GENRES[name]).filter(Boolean);
  return ids.length ? ids.join(",") : undefined;
};

const hydrateGenres = ids =>
  (ids || [])
    .map(id => Object.keys(GENRES).find(name => GENRES[name] === id))
    .filter(Boolean);

const formatMovie = movie => ({
  title: movie.title,
  year: (movie.release_date || "").slice(0, 4),
  overview: movie.overview,
  genres: hydrateGenres(movie.genre_ids),
  poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null
});

async function fetchMovies(prefs) {
  const [from, to] = prefs.yearRange || [2000, 2025];
  const params = {
    api_key: process.env.TMDB_KEY,
    with_genres: toCsv(prefs.genres),
    without_genres: toCsv(prefs.avoid),
    with_original_language: prefs.language || undefined,
    primary_release_date_gte: `${from}-01-01`,
    primary_release_date_lte: `${to}-12-31`,
    sort_by: "popularity.desc",
    vote_count_gte: 500,
    page: 1
  };

  const { data } = await axios.get("https://api.themoviedb.org/3/discover/movie", { params });
  return (data.results || []).slice(0, 10).map(formatMovie);
}

const mockReasons = (preferences, movies, limit) => ({
  picks: movies.slice(0, limit).map(movie => ({
    title: movie.title,
    why: `Matches your "${preferences.mood || "requested"}" mood with ${movie.genres.slice(0, 2).join("/")} energy.`
  }))
});

const stripToJson = text => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end === -1 ? "{}" : text.slice(start, end + 1);
};

async function explainChoices(preferences, movies, limit = 5) {
  if (MOCK_MODE) return mockReasons(preferences, movies, limit);

  const prompt = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 400,
    system: 'Recommend movies. Respond with JSON only: {"picks":[{"title":"","why":""}]}. Each "why" under 20 words, no spoilers.',
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `User preferences:\n${JSON.stringify(preferences, null, 2)}\n\nCandidate movies:\n${JSON.stringify(
              movies,
              null,
              2
            )}\n\nPick up to ${limit} movies and explain why each fits.`
          }
        ]
      }
    ]
  };

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(prompt)
    })
  );

  const decoded = new TextDecoder().decode(response.body);
  const body = JSON.parse(decoded);
  const raw = body?.content?.[0]?.text || "{}";

  try {
    return JSON.parse(stripToJson(raw));
  } catch {
    return { picks: [] };
  }
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/recommend", async (req, res) => {
  try {
    const prefs = { ...DEFAULT_PREFS, ...(req.body?.prefs || {}) };
    const limit = Math.min(Number(req.body?.limit) || 5, 10);
    const movies = await fetchMovies(prefs);
    const reasons = await explainChoices(prefs, movies, limit);
    const normalizeTitle = value => (value || "").toLowerCase();
    const findMovie = movieTitle => {
      if (!movieTitle) return null;
      const needle = normalizeTitle(movieTitle);
      return movies.find(movie => normalizeTitle(movie.title) === needle);
    };

    const picks = (reasons.picks || []).map(pick => {
      const match = findMovie(pick.title);
      return {
        title: pick.title,
        why: pick.why,
        poster: match?.poster || null,
        year: match?.year || null,
        genres: match?.genres || [],
        overview: match?.overview || ""
      };
    });

    res.json({
      picks,
      prefs,
      disclaimer: "For entertainment purposes."
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log("Mini AI Assistant running at http://localhost:3000");
});
