import fm from 'front-matter';
import OpenAI from "openai";
import dotenv from 'dotenv';

// Configure dotenv to load environment variables
dotenv.config();

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.DEEPSEEK_API_KEY,
});

//https://github.com/expo/expo/edit/main/docs/pages/get-started/start-developing.mdx

const parseExpoDocs = async (slug) => {
    const url = 'https://raw.githubusercontent.com/expo/expo/refs/heads/main/docs/pages/get-started/start-developing.mdx';
    const response = await fetch(url);
    const content = await response.text();

    const data = fm(content);
    return data;
}

const handleDoc = async (slug) => {
    const completion = await openai.chat.completions.create({
        model: "deepseek/deepseek-chat-v3-0324:free",
        messages: [
            {
                "role": "user",
                "content": "What is the meaning of life?"
            }
        ],

    });

    console.log(completion.choices[0].message);
}

handleDoc('get-started/start-developing/')