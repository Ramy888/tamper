// The one Claude loop, reused by the Recon and Patcher agents with different prompts.
// Always injectable, so the engine and its tests run with the model faked and spend nothing.
// Real calls happen only through makeLLM(), and only after the user has approved the spend.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.TAMPER_MODEL ?? "claude-sonnet-5-5";

export function makeLLM({ apiKey = process.env.ANTHROPIC_API_KEY, model = MODEL } = {}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });
  return {
    async complete(system, user, maxTokens = 700) {
      const msg = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      return msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}

// For tests and for any dry run: a deterministic stand-in with no network and no spend.
export const fakeLLM = (responder = () => "(faked)") => ({
  complete: async (system, user) => (typeof responder === "function" ? responder(system, user) : responder),
});
