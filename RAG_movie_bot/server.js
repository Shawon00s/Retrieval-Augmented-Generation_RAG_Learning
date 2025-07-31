const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');
const cors = require('cors');
const bodyParser = require('body-parser');
const natural = require('natural');
const Fuse = require('fuse.js');
const path = require('path');
const axios = require('axios');
require('dotenv').config(); // Load environment variables

const app = express();
const PORT = process.env.PORT || 3001;

// LLM Configuration
const LLM_CONFIG = {
    // Option 1: Ollama (Local, Free)
    ollama: {
        enabled: false, // Set to true to use Ollama
        url: 'http://localhost:11434',
        model: 'llama3.1:8b' // or 'mistral', 'codellama', etc.
    },

    // Option 2: Google Gemini (Cloud, Free Tier)
    gemini: {
        enabled: true, // Set to true to use Gemini
        apiKey: process.env.GEMINI_API_KEY, // API key from environment variables
        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash'
    }
};

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Global variables to store movie data
let movies = [];
let fuseInstance = null;

// Initialize tokenizer and stemmer
const tokenizer = new natural.WordTokenizer();
const stemmer = natural.PorterStemmer;

// Load and process CSV data
function loadMovieData() {
    return new Promise((resolve, reject) => {
        const movieData = [];

        fs.createReadStream('IMDB_Movies_Dataset.csv')
            .pipe(csv())
            .on('data', (row) => {
                // Clean and structure the data
                const movie = {
                    title: row.Title || '',
                    rating: row['Average Rating'] || '',
                    director: row.Director || '',
                    writer: row.Writer || '',
                    metascore: row.Metascore || '',
                    cast: row.Cast || '',
                    releaseDate: row['Release Date'] || '',
                    country: row['Country of Origin'] || '',
                    languages: row.Languages || '',
                    budget: row.Budget || '',
                    gross: row['Worldwide Gross'] || '',
                    runtime: row.Runtime || ''
                };

                // Create searchable text combining all fields
                movie.searchableText = `${movie.title} ${movie.director} ${movie.writer} ${movie.cast} ${movie.country} ${movie.languages}`.toLowerCase();

                movieData.push(movie);
            })
            .on('end', () => {
                movies = movieData;

                // Initialize Fuse.js for fuzzy searching
                const fuseOptions = {
                    keys: [
                        { name: 'title', weight: 0.7 },
                        { name: 'searchableText', weight: 0.3 }
                    ],
                    threshold: 0.3,
                    includeScore: true,
                    minMatchCharLength: 2,
                    ignoreLocation: true,
                    findAllMatches: true
                };

                fuseInstance = new Fuse(movies, fuseOptions);
                console.log(`Loaded ${movies.length} movies`);
                resolve();
            })
            .on('error', reject);
    });
}

// LLM Integration Functions

// Ollama Integration
async function queryOllama(prompt) {
    try {
        const response = await axios.post(`${LLM_CONFIG.ollama.url}/api/generate`, {
            model: LLM_CONFIG.ollama.model,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.3,
                top_p: 0.9,
                max_tokens: 1000  // Increased from 500 to 1000 for longer responses
            }
        });

        return response.data.response;
    } catch (error) {
        console.error('Ollama API error:', error.message);
        throw new Error('Failed to connect to local LLM. Make sure Ollama is running.');
    }
}

// Google Gemini Integration
async function queryGemini(prompt) {
    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${LLM_CONFIG.gemini.model}:generateContent?key=${LLM_CONFIG.gemini.apiKey}`,
            {
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.3,
                    topP: 0.9,
                    maxOutputTokens: 1000  // Increased from 500 to 1000 for longer responses
                }
            }
        );

        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error('Gemini API error:', error.message);
        throw new Error('Failed to connect to Gemini API. Check your API key.');
    }
}

// Enhanced search with LLM context
function searchMoviesAdvanced(query) {
    // First, try to extract movie titles using both traditional and semantic approaches
    const extractedTitle = extractMovieTitle(query);
    console.log('Extracted movie title:', extractedTitle);

    // Exact match search
    const exactMatches = movies.filter(movie =>
        movie.title.toLowerCase() === extractedTitle.toLowerCase()
    );

    if (exactMatches.length > 0) {
        console.log('Found exact matches:', exactMatches.length);
        return exactMatches.map(movie => ({
            item: movie,  // Changed from 'movie' to 'item' to match Fuse.js structure
            score: 0.0
        }));
    }

    // Fuzzy search
    const results = fuseInstance.search(extractedTitle);

    // If no good results, try searching with the full query
    if (results.length === 0 || (results[0] && results[0].score > 0.4)) {
        const fullQueryResults = fuseInstance.search(query);
        if (fullQueryResults.length > 0 && (!results[0] || fullQueryResults[0].score < results[0].score)) {
            return fullQueryResults.slice(0, 5).map(result => ({
                item: result.item,
                score: result.score
            }));
        }
    }

    return results.slice(0, 5).map(result => ({
        item: result.item,
        score: result.score
    }));
}

// Enhanced response generation with LLM
async function generateLLMResponse(query, searchResults, queryType) {
    if (searchResults.length === 0) {
        const prompt = `The user asked: "${query}"

No movies were found matching this query in the IMDB dataset. Please provide a comprehensive, helpful response that:

1. Acknowledges that no exact matches were found in the database
2. Suggests they might check the spelling of the movie title
3. Mention that movies might be known by different titles (original vs. international)
4. Suggest they can try searching with partial titles or alternative names
5. Encourage them to ask about other movies in the database
6. If the query seems to be about a specific genre, director, or topic, provide some general insights
7. Make the response friendly, encouraging, and detailed (3-4 sentences)

Keep the response conversational and helpful.`;

        try {
            if (LLM_CONFIG.ollama.enabled) {
                return await queryOllama(prompt);
            } else if (LLM_CONFIG.gemini.enabled) {
                return await queryGemini(prompt);
            }
        } catch (error) {
            console.error('LLM Error:', error.message);
        }

        return "I couldn't find any movies matching your query. Please check the spelling or try a different movie title.";
    }

    // Prepare context for LLM
    const relevantMovies = searchResults.slice(0, 3).map(result => {
        const movie = result.item;
        return {
            title: movie.title,
            director: movie.director,
            writer: movie.writer,
            cast: movie.cast,
            rating: movie.rating,
            metascore: movie.metascore,
            releaseDate: movie.releaseDate,
            country: movie.country,
            languages: movie.languages,
            budget: movie.budget,
            gross: movie.gross,
            runtime: movie.runtime,
            matchScore: result.score
        };
    });

    const prompt = `You are a knowledgeable movie information assistant with expertise in cinema history. A user asked: "${query}"

Here are the relevant movies from the IMDB database:

${relevantMovies.map((movie, index) => `
Movie ${index + 1}: "${movie.title}"
- Director: ${movie.director || 'Not available'}
- Writer: ${movie.writer || 'Not available'}
- Cast: ${movie.cast || 'Not available'}
- Rating: ${movie.rating || 'Not available'}
- Metascore: ${movie.metascore || 'Not available'}
- Release Date: ${movie.releaseDate || 'Not available'}
- Country: ${movie.country || 'Not available'}
- Languages: ${movie.languages || 'Not available'}
- Budget: ${movie.budget || 'Not available'}
- Worldwide Gross: ${movie.gross || 'Not available'}
- Runtime: ${movie.runtime || 'Not available'}
- Match Score: ${movie.matchScore.toFixed(3)} (lower is better)
`).join('\n')}

Please provide a comprehensive, engaging response that:
1. Directly answers the user's question using the movie data above
2. Uses the movie with the best match score (lowest number) as the primary answer
3. Provides rich context and background information about the movie, director, or topic
4. Include interesting details about the production, cast, or cultural impact when relevant
5. If asking about a specific person (director, actor), mention their other notable works if you know them
6. For ratings or box office questions, provide context about what makes those numbers significant
7. If the match score is > 0.2, mention that this might not be exactly what they were looking for
8. Format movie titles in quotes like "The Godfather"
9. Make the response conversational, informative, and engaging
10. Aim for 3-5 sentences minimum to provide comprehensive information

Response:`;

    try {
        if (LLM_CONFIG.ollama.enabled) {
            return await queryOllama(prompt);
        } else if (LLM_CONFIG.gemini.enabled) {
            return await queryGemini(prompt);
        }
    } catch (error) {
        console.error('LLM Error:', error.message);
        // Fallback to traditional response
        return generateTraditionalResponse(query, searchResults, queryType);
    }

    // Fallback if no LLM is configured
    return generateTraditionalResponse(query, searchResults, queryType);
}

// Traditional response generation (fallback)
function generateTraditionalResponse(query, searchResults, queryType) {
    const bestMatch = searchResults[0].item;  // Changed from .movie to .item
    const bestScore = searchResults[0].score;
    const title = bestMatch.title;

    let response = "";

    switch (queryType) {
        case 'director':
            response = `The director of "${title}" is ${bestMatch.director || 'not available'}.`;
            break;
        case 'writer':
            response = `The writer(s) of "${title}" are ${bestMatch.writer || 'not available'}.`;
            break;
        case 'cast':
            response = `The main cast of "${title}" includes: ${bestMatch.cast || 'not available'}.`;
            break;
        case 'rating':
            response = `"${title}" has an average rating of ${bestMatch.rating || 'not available'}`;
            if (bestMatch.metascore) {
                response += ` and a Metascore of ${bestMatch.metascore}`;
            }
            response += ".";
            break;
        case 'releaseDate':
            response = `"${title}" was released on ${bestMatch.releaseDate || 'date not available'}.`;
            break;
        case 'country':
            response = `"${title}" is from ${bestMatch.country || 'country not available'}.`;
            break;
        case 'languages':
            response = `"${title}" is available in ${bestMatch.languages || 'languages not available'}.`;
            break;
        case 'budget':
            response = `The budget of "${title}" was ${bestMatch.budget || 'not available'}.`;
            break;
        case 'gross':
            response = `"${title}" grossed ${bestMatch.gross || 'earnings not available'} worldwide.`;
            break;
        case 'runtime':
            response = `The runtime of "${title}" is ${bestMatch.runtime || 'not available'}.`;
            break;
        default:
            response = `Here's information about "${title}":
            - Director: ${bestMatch.director || 'Not available'}
            - Rating: ${bestMatch.rating || 'Not available'}
            - Release Date: ${bestMatch.releaseDate || 'Not available'}
            - Cast: ${bestMatch.cast || 'Not available'}`;
    }

    if (bestScore > 0.2) {
        response += "\n\n(Note: This might not be an exact match. Please verify the movie title.)";
    }

    return response;
}

// Keep the original extraction and query type functions
function extractMovieTitle(query) {
    const originalQuery = query;
    const lowerQuery = query.toLowerCase();

    // Look for potential movie titles in quotes first
    const quotedMatch = query.match(/["']([^"']+)["']/);
    if (quotedMatch) {
        return quotedMatch[1].trim();
    }

    // Look for patterns like "director of [movie]", "cast of [movie]", etc.
    const patterns = [
        /(?:director|writer|cast|actors?|rating|budget|runtime|gross|earnings?)\s+of\s+(.+?)(?:\?|$)/i,
        /(?:who\s+(?:is|are|was|were)\s+(?:the\s+)?(?:director|writer|cast|actors?|stars?)\s+(?:of|in)\s+)(.+?)(?:\?|$)/i,
        /(?:what\s+(?:is|was)\s+(?:the\s+)?(?:rating|budget|runtime|gross|earnings?)\s+(?:of|for)\s+)(.+?)(?:\?|$)/i,
        /(?:when\s+(?:was|did)\s+)(.+?)(?:\s+(?:released?|come\s+out))(?:\?|$)/i,
        /(?:how\s+long\s+(?:is|was)\s+)(.+?)(?:\?|$)/i,
        /(?:tell\s+me\s+about\s+)(.+?)(?:\?|$)/i
    ];

    for (const pattern of patterns) {
        const match = query.match(pattern);
        if (match && match[1]) {
            let title = match[1].trim();
            title = title.replace(/(?:the\s+movie|the\s+film|movie|film)$/i, '').trim();
            if (title.length > 0) {
                return title;
            }
        }
    }

    // Fallback: remove common question words and take the remaining meaningful words
    const words = tokenizer.tokenize(query);
    const questionWords = ['what', 'is', 'the', 'who', 'when', 'where', 'how', 'of', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'was', 'were', 'are', 'director', 'writer', 'cast', 'actor', 'actress', 'rating', 'budget', 'runtime', 'gross', 'earnings', 'released', 'release', 'date'];
    const meaningfulWords = words.filter(word =>
        !questionWords.includes(word.toLowerCase()) &&
        word.length > 1 &&
        !/^\?+$/.test(word)
    );

    return meaningfulWords.join(' ').trim() || query;
}

function determineQueryType(query) {
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.includes('director')) return 'director';
    if (lowerQuery.includes('writer') || lowerQuery.includes('screenplay') || lowerQuery.includes('script')) return 'writer';
    if (lowerQuery.includes('cast') || lowerQuery.includes('actor') || lowerQuery.includes('actress') || lowerQuery.includes('star')) return 'cast';
    if (lowerQuery.includes('rating') || lowerQuery.includes('score')) return 'rating';
    if (lowerQuery.includes('release') || lowerQuery.includes('year') || lowerQuery.includes('date')) return 'releaseDate';
    if (lowerQuery.includes('country') || lowerQuery.includes('origin')) return 'country';
    if (lowerQuery.includes('language')) return 'languages';
    if (lowerQuery.includes('budget') || lowerQuery.includes('cost')) return 'budget';
    if (lowerQuery.includes('gross') || lowerQuery.includes('earning') || lowerQuery.includes('revenue')) return 'gross';
    if (lowerQuery.includes('runtime') || lowerQuery.includes('duration') || lowerQuery.includes('length')) return 'runtime';

    return 'general';
}

// API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/query', async (req, res) => {
    try {
        const { query } = req.body;

        if (!query || query.trim().length === 0) {
            return res.status(400).json({
                error: 'Query is required',
                response: 'Please provide a question about movies.'
            });
        }

        console.log('Received query:', query);

        // Process the query
        const queryType = determineQueryType(query);
        const searchResults = searchMoviesAdvanced(query);

        // Use LLM for response generation if available
        const response = await generateLLMResponse(query, searchResults, queryType);

        res.json({
            query: query,
            queryType: queryType,
            response: response,
            matches: searchResults.length,
            llmUsed: LLM_CONFIG.ollama.enabled || LLM_CONFIG.gemini.enabled
        });

    } catch (error) {
        console.error('Error processing query:', error);
        res.status(500).json({
            error: 'Internal server error',
            response: 'Sorry, I encountered an error while processing your question.'
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        moviesLoaded: movies.length,
        llmEnabled: LLM_CONFIG.ollama.enabled || LLM_CONFIG.gemini.enabled,
        llmType: LLM_CONFIG.ollama.enabled ? 'ollama' : (LLM_CONFIG.gemini.enabled ? 'gemini' : 'none'),
        timestamp: new Date().toISOString()
    });
});

// Initialize and start server
async function startServer() {
    try {
        console.log('Loading movie data...');
        await loadMovieData();
        console.log('Movie data loaded successfully!');

        // Test LLM connection
        if (LLM_CONFIG.ollama.enabled) {
            try {
                await queryOllama('Test connection');
                console.log('✅ Ollama LLM connected successfully!');
            } catch (error) {
                console.log('⚠️  Ollama not available:', error.message);
                console.log('💡 To use Ollama: Install from https://ollama.ai/ and run: ollama pull llama3.1:8b');
            }
        }

        if (LLM_CONFIG.gemini.enabled) {
            if (LLM_CONFIG.gemini.apiKey === 'YOUR_GEMINI_API_KEY') {
                console.log('⚠️  Gemini API key not configured');
                console.log('💡 Get your free API key from: https://makersuite.google.com/app/apikey');
            } else {
                console.log('✅ Gemini API configured');
            }
        }

        app.listen(PORT, () => {
            console.log(`🎬 Enhanced RAG Movie Bot server is running on http://localhost:${PORT}`);
            console.log(`📊 Loaded ${movies.length} movies from the dataset`);
            console.log(`🤖 LLM Integration: ${LLM_CONFIG.ollama.enabled ? 'Ollama' : (LLM_CONFIG.gemini.enabled ? 'Gemini' : 'Disabled')}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
