export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChatProvider {
  chat(messages: Message[]): Promise<Record<string, unknown>>;
}