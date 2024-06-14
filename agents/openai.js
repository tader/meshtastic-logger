import OpenAI from "openai";
import axios from "axios";

export class OpenAIAgent {
    openAIKey;
    openAIAssistantId;
    tavilyKey;
    openai;

    constructor(openAIKey, openAIAssistantId, tavilyKey = null) {
        this.openAIKey = openAIKey;
        this.openAIAssistantId = openAIAssistantId;
        this.tavilyKey = tavilyKey;
        
        this.openai = new OpenAI({
            apiKey: this.openAIKey,
        });
    }

    async callTavily(args) {
        if (this.tavilyKey) {
            const results = await axios.request({
                method: "POST",
                url: "https://api.tavily.com/search",
                data: {
                    api_key: this.tavilyKey,
                    query: args["query"]
                }
            });
            return results.data;
        } else {
            return "Sorry, I can't search the web";
        }
    }

    async callTools(thread_id, run_id, tools_to_call) {
        console.log("Calling tools:", tools_to_call);
        const tools = {
            tavily_search: this.callTavily,
        }

        const tool_outputs = [];

        for (const tool of tools_to_call) {
            const fn = tools[tool.function.name];

            if (typeof fn === "function") {
                tool_outputs.push({
                    tool_call_id: tool.id,
                    output: JSON.stringify(await fn(JSON.parse(tool.function.arguments))),
                });
            }
        }

        console.log(tool_outputs);

        await this.openai.beta.threads.runs.submitToolOutputs(
            thread_id,
            run_id,
            {
                tool_outputs: tool_outputs,
            }
        );
    }

    async handleMessage(context) {
        const packet = context.packet;
        try {
            const thread_id = await context.get("thread_id", async () => {
                const thread = await this.openai.beta.threads.create();
                return thread.id;
            });

            await this.openai.beta.threads.messages.create(thread_id, {
                role: "user",
                content: JSON.stringify({
                    currentTime: new Date().toString(),
                    radio: {
                        rx_signal: {
                            rssi: packet.rxRssi,
                            snr: packet.rxSnr,
                        },
                        hops: typeof packet.hopStart === "undefined" ? undefined : packet.hopStart - packet.hopLimit,
                    },
                    message: context.message
                }),
                metadata: {
                    from: packet.from.toString(16),
                    packet_id: packet.id.toString(16),
                }
            });

            const run = await this.openai.beta.threads.runs.create(
                thread_id,
                { assistant_id: this.openAIAssistantId }
            );

            let result = null;
            while (result === null || ['queued', 'in_progress', 'requires_action'].indexOf(result.status) >= 0) {
                if (result?.status === "requires_action") {
                    await this.callTools(thread_id, run.id, result.required_action.submit_tool_outputs.tool_calls);
                }

                await new Promise((resolve, reject) => setTimeout(resolve, 1000));
                result = await this.openai.beta.threads.runs.retrieve(
                    thread_id,
                    run.id,
                );
            }

            if (result.status === "completed") {
                const messages = await this.openai.beta.threads.messages.list(thread_id);

                let in_reply_to = null;

                for (const msg of messages.data) {
                    if (msg.role === "assistant") {
                        for (const content of msg.content) {
                            if (content.type === "text") {
                                await context.reply(content.text.value, in_reply_to);
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        } catch(err) {
            console.error(err);
        }
    }
}
