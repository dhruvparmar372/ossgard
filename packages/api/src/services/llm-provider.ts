export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  embed(texts: string[]): Promise<number[][]>;
  chat(messages: Message[]): Promise<Record<string, unknown>>;
}
