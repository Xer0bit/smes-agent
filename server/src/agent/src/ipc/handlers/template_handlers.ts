import log from "electron-log";
import { getAllTemplates } from "../utils/template_utils.js";
import { localTemplatesData } from "../../shared/templates.js";
import { createTypedHandler } from "./base.js";
import { templateContracts } from "../types/templates.js";

const logger = log.scope("template_handlers");

export function registerTemplateHandlers() {
  createTypedHandler(templateContracts.getTemplates, async () => {
    try {
      const templates = await getAllTemplates();
      return templates;
    } catch (error) {
      logger.error("Error fetching templates:", error);
      return localTemplatesData;
    }
  });
}
