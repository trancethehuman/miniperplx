import { openai } from "@ai-sdk/openai";
import { anthropic } from '@ai-sdk/anthropic'
import { convertToCoreMessages, streamText, tool } from "ai";
import { z } from "zod";
import { geolocation } from '@vercel/functions'

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages, model } = await req.json();
  const { latitude, longitude, city } = geolocation(req)

  let ansmodel;

  if (model === "claude-3-5-sonnet-20240620") {
    ansmodel = anthropic("claude-3-5-sonnet-20240620")
  } else {
    ansmodel = openai(model)
  }

  const result = await streamText({
    model: ansmodel,
    messages: convertToCoreMessages(messages),
    system:
      "You are an AI web search engine that helps users find information on the internet." +
      "The user is located in " + city + " at latitude " + latitude + " and longitude " + longitude + "." +
      "Use this geolocation data for weather tool." +
      "You use the 'web_search' tool to search for information on the internet." +
      "Always call the 'web_search' tool to get the information, no need to do a chain of thought or say anything else, go straight to the point." +
      "Once you have found the information, you provide the user with the information you found in brief like a news paper detail." +
      "The detail should be 3-5 paragraphs in 10-12 sentences, some time pointers, each with citations in the [Text](link) format always!" +
      "Citations can be inline of the text like this: Hey there! [Google](https://google.com) is a search engine." +
      "Do not start the responses with newline characters, always start with the first sentence." +
      "When the user asks about a Stock, you should 'always' first gather news about it with web search tool, then show the chart and then write your response. Follow these steps in this order only!" +
      "Never use the retrieve tool for general search. Always use it when the user provides an url! " +
      "For weather related questions, use get_weather_data tool and write your response. No need to call any other tool. Put citation to OpenWeatherMaps API everytime." +
      "The current date is: " +
      new Date()
        .toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "2-digit",
          weekday: "short",
        })
        .replace(/(\w+), (\w+) (\d+), (\d+)/, "$4-$2-$3 ($1)") +
      "Never use the heading format in your response!." +
      "Refrain from saying things like 'Certainly! I'll search for information about OpenAI GPT-4o mini using the web search tool.'",
    tools: {
      web_search: tool({
        description: 'Search the web for information with the given query, max results and search depth.',
        parameters: z.object({
          query: z.string()
            .describe('The search query to look up on the web.'),
          maxResults: z.number()
            .describe('The maximum number of results to return. Default to be used is 10.'),
          searchDepth: // use basic | advanced 
            z.enum(['basic', 'advanced'])
              .describe('The search depth to use for the search. Default is basic.')
        }),
        execute: async ({ query, maxResults, searchDepth }: { query: string, maxResults: number, searchDepth: 'basic' | 'advanced' }) => {
          const apiKey = process.env.TAVILY_API_KEY
          const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              api_key: apiKey,
              query,
              max_results: maxResults < 5 ? 5 : maxResults,
              search_depth: searchDepth,
              include_images: true,
              include_answers: true
            })
          })

          const data = await response.json()

          let context = data.results.map((obj: { url: any; content: any; title: any; raw_content: any; }) => {
            return {
              url: obj.url,
              title: obj.title,
              content: obj.content,
              raw_content: obj.raw_content
            }
          })

          return {
            results: context
          }
        }
      }),
      retrieve: tool({
        description: 'Retrieve the information from the web search tool.',
        parameters: z.object({
          url: z.string().describe('The URL to retrieve the information from.')
        }),
        execute: async ({ url }: { url: string }) => {
          let hasError = false

          let results;
          try {
            const response = await fetch(`https://r.jina.ai/${url}`, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'X-With-Generated-Alt': 'true'
              }
            })
            const json = await response.json()
            if (!json.data || json.data.length === 0) {
              hasError = true
            } else {
              // Limit the content to 5000 characters
              if (json.data.content.length > 5000) {
                json.data.content = json.data.content.slice(0, 5000)
              }
              results = {
                results: [
                  {
                    title: json.data.title,
                    content: json.data.content,
                    url: json.data.url
                  }
                ],
                query: '',
                images: []
              }
            }
          } catch (error) {
            hasError = true
            console.error('Retrieve API error:', error)
          }

          if (hasError || !results) {
            return results
          }

          return results
        }
      }),
      get_weather_data: tool({
        description: "Get the weather data for the given coordinates.",
        parameters: z.object({
          lat: z.number().describe('The latitude of the location.'),
          lon: z.number().describe('The longitude of the location.')
        }),
        execute: async ({ lat, lon }: { lat: number, lon: number }) => {
          const apiKey = process.env.OPENWEATHER_API_KEY
          const response = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}`)
          const data = await response.json()
          return data
        }
      }),
      stock_chart_ui: tool({
        description: 'Display the stock chart for the given stock symbol after web search.',
        parameters: z.object({
          symbol: z.string().describe('The stock symbol to display the chart for.')
        }),
      }),
    },
    onFinish: async (event) => {
      console.log(event.text);
      console.log("Called " + event.toolCalls?.map((toolCall) => toolCall.toolName));
    }
  });

  return result.toAIStreamResponse();
}
