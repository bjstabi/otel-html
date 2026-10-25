export type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
export type MathOp = '+' | '-' | '*' | '/';

export type Expr =
  | { type: 'or' | 'and'; left: Expr; right: Expr }
  | { type: 'not'; expr: Expr }
  | { type: 'cmp'; op: CmpOp; left: Value; right: Value }
  | { type: 'value'; value: Value };

export type Value =
  | { type: 'path'; segments: readonly string[]; keys: readonly (string | number)[]; from: number }
  | { type: 'literal'; value: string | bigint | number | boolean | null }
  | { type: 'enum'; name: string }
  | { type: 'call'; name: string; args: readonly Value[]; from: number }
  | { type: 'math'; op: MathOp; left: Value; right: Value };
