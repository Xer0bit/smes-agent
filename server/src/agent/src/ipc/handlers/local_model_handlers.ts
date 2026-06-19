import { registerOllamaHandlers } from "./local_model_ollama_handler.js";
import { registerLMStudioHandlers } from "./local_model_lmstudio_handler.js";

export function registerLocalModelHandlers() {
  registerOllamaHandlers();
  registerLMStudioHandlers();
}
