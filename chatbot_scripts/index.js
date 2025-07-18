import fm from 'front-matter';
import OpenAI from "openai";
import dotenv from 'dotenv';

// Configure dotenv to load environment variables
dotenv.config();

// OpenRouter for chat completions
const openrouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.DEEPSEEK_API_KEY,
});

// OpenAI for embeddings (only if API key is provided)
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
}

//https://github.com/expo/expo/edit/main/docs/pages/get-started/start-developing.mdx

// Simple local embedding function (basic text hashing)
const createSimpleEmbedding = (text) => {
    const words = text.toLowerCase().split(/\s+/);
    const vector = new Array(100).fill(0); // 100-dimensional vector

    words.forEach((word, index) => {
        const hash = word.split('').reduce((acc, char) => {
            return acc + char.charCodeAt(0);
        }, 0);
        vector[hash % 100] += 1;
    });

    // Normalize the vector
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return vector.map(val => magnitude > 0 ? val / magnitude : 0);
};

const parseExpoDocs = async (slug) => {
    const url = 'https://raw.githubusercontent.com/expo/expo/refs/heads/main/docs/pages/get-started/start-developing.mdx';
    const response = await fetch(url);
    const content = await response.text();

    const data = fm(content);
    return data;
}

const handleDoc = async (slug) => {
    const data = await parseExpoDocs(slug);

    // Create embeddings using OpenAI API (if available)
    let embedding;
    try {
        if (openai && process.env.OPENAI_API_KEY) {
            console.log("Creating embeddings using OpenAI...");
            embedding = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: data.body.substring(0, 8000), // Limit input size
                encoding_format: "float",
            });
            console.log("✅ Embedding created successfully!");
            console.log("Embedding dimensions:", embedding.data[0].embedding.length);
            console.log("First few embedding values:", embedding.data[0].embedding.slice(0, 5));
        } else {
            console.log("⚠️ OPENAI_API_KEY not found. Creating simple local embedding...");
            const simpleEmbedding = createSimpleEmbedding(data.body.substring(0, 8000));
            embedding = {
                data: [{
                    embedding: simpleEmbedding,
                    object: "embedding"
                }]
            };
            console.log("✅ Simple embedding created!");
            console.log("Embedding dimensions:", embedding.data[0].embedding.length);
            console.log("First few embedding values:", embedding.data[0].embedding.slice(0, 5));
        }
    } catch (error) {
        console.log("❌ Error creating embedding:", error.message);
    }

    // Chat completion using OpenRouter
    console.log("\nMaking chat completion request...");
    /*const completion = await openrouter.chat.completions.create({
        model: "deepseek/deepseek-chat",
        messages: [
            {
                "role": "system",
                "content": "You are a helpful assistant that answers questions about Expo documentation."
            },
            {
                "role": "user",
                "content": `Based on this Expo documentation, provide a brief summary: ${data.body.substring(0, 1000)}`
            }
        ],
    });
    console.log("Chat response:", completion.choices[0].message.content);*/

    return { embedding/*, completion */};
}

handleDoc('get-started/start-developing/')