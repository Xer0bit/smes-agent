import * as ts from 'typescript';

export interface AstValidationError {
  line: number;
  column: number;
  message: string;
  code: number;
}

export interface AstValidationResult {
  valid: boolean;
  errors: AstValidationError[];
}

/**
 * Pre-flight AST interceptor to validate TypeScript/JavaScript syntax before
 * writing files to disk or applying diffs.
 */
export function validateCodeAst(filePath: string, content: string): AstValidationResult {
  if (filePath.endsWith('.d.ts')) {
    return { valid: true, errors: [] };
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  let scriptKind: ts.ScriptKind | null = null;

  switch (ext) {
    case 'tsx':
      scriptKind = ts.ScriptKind.TSX;
      break;
    case 'ts':
    case 'mts':
    case 'cts':
      scriptKind = ts.ScriptKind.TS;
      break;
    case 'jsx':
      scriptKind = ts.ScriptKind.JSX;
      break;
    case 'js':
    case 'mjs':
    case 'cjs':
      scriptKind = ts.ScriptKind.JS;
      break;
    default:
      // Non-script file (CSS, HTML, JSON, markdown, asset) - skip AST validation
      return { valid: true, errors: [] };
  }

  try {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.ES2022,
      true,
      scriptKind
    );

    const diagnostics: ts.Diagnostic[] = (sourceFile as any).parseDiagnostics || [];

    if (diagnostics.length === 0) {
      return { valid: true, errors: [] };
    }

    const errors: AstValidationError[] = diagnostics.map((diag) => {
      const start = diag.start ?? 0;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      return {
        line: line + 1,
        column: character + 1,
        message,
        code: diag.code,
      };
    });

    return {
      valid: false,
      errors,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [
        {
          line: 1,
          column: 1,
          message: `AST Parsing Exception: ${message}`,
          code: 9999,
        },
      ],
    };
  }
}
