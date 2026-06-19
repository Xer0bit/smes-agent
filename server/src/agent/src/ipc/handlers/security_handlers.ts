import { db } from "../../db/index.js";
import { chats, messages } from "../../db/schema.js";
import { eq, and, like, desc } from "drizzle-orm";
import { createTypedHandler } from "./base.js";
import { securityContracts } from "../types/security.js";
import type { SecurityFinding } from "../types/security.js";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

export function registerSecurityHandlers() {
  createTypedHandler(
    securityContracts.getLatestSecurityReview,
    async (_, appId) => {
      if (!appId) {
        throw new DyadError("App ID is required", DyadErrorKind.Validation);
      }

      // Query for the most recent message with security findings
      // Use database filtering instead of loading all data into memory
      const result = await db
        .select({
          content: messages.content,
          createdAt: messages.createdAt,
          chatId: messages.chatId,
        })
        .from(messages)
        .innerJoin(chats, eq(messages.chatId, chats.id))
        .where(
          and(
            eq(chats.appId, appId),
            eq(messages.role, "assistant"),
            like(messages.content, "%<dyad-security-finding%"),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);

      if (result.length === 0) {
        throw new DyadError(
          "No security review found for this app",
          DyadErrorKind.NotFound,
        );
      }

      const message = result[0];
      const findings = parseSecurityFindings(message.content);

      if (findings.length === 0) {
        throw new DyadError(
          "No security review found for this app",
          DyadErrorKind.NotFound,
        );
      }

      return {
        findings,
        timestamp: message.createdAt.toISOString(),
        chatId: message.chatId,
      };
    },
  );
}

function parseSecurityFindings(content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Regex to match dyad-security-finding tags
  // Using lazy quantifier with proper boundaries to prevent catastrophic backtracking
  const regex =
    /<dyad-security-finding\s+title="([^"]+)"\s+level="(critical|high|medium|low)">([\s\S]*?)<\/dyad-security-finding>/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const [, title, level, description] = match;
    findings.push({
      title: title.trim(),
      level: level as "critical" | "high" | "medium" | "low",
      description: description.trim(),
    });
  }

  return findings;
}
