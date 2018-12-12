import { Option, Dict } from '@glimmer/interfaces';

const tuple = <T extends string[]>(...args: T) => args;

export const OPERAND_TYPES = tuple(
  'unknown',
  'scope',
  'symbol-table',
  'locator',
  'handle',
  'i32',
  'u32',
  'to',
  'str',
  'option-str',
  'str-array',
  'array',
  'bool',
  'primitive',
  'table',
  'symbol',
  'block',
  'register',
  'serializable',
  'lazy-constant'
);

function isOperandType(s: string): s is OperandType {
  return OPERAND_TYPES.indexOf(s as any) !== -1;
}

export type OperandType = typeof OPERAND_TYPES[number];

export interface Operand {
  type: OperandType;
  name: string;
}

export type OperandList = ([] | [Operand] | [Operand, Operand] | [Operand, Operand, Operand]) &
  Operand[];

export interface NormalizedMetadata {
  name: string;
  mnemonic: string;
  before: null;
  stackChange: Option<number>;
  ops: OperandList;
  operands: number;
  check: boolean;
}

export type Stack = [string[], string[]];

export interface RawOperandMetadata {
  kind: 'machine' | 'syscall';
  format: RawOperandFormat;
  skip?: true;
  operation: string;
  'operand-stack'?: [string[], string[]];
  notes?: string;
}

export type RawOperandFormat = string | string[];

export function normalize(key: string, input: RawOperandMetadata): NormalizedMetadata {
  let name;

  if (input.format === undefined) {
    throw new Error(`Missing format in ${JSON.stringify(input)}`);
  }

  if (Array.isArray(input.format)) {
    name = input.format[0];
  } else {
    name = input.format;
  }

  let ops: OperandList = Array.isArray(input.format) ? operands(input.format.slice(1)) : [];

  return {
    name,
    mnemonic: key,
    before: null,
    stackChange: stackChange(input['operand-stack']),
    ops,
    operands: ops.length,
    check: input.skip === true ? false : true,
  };
}

function stackChange(stack?: Stack): Option<number> {
  if (stack === undefined) {
    return 0;
  }

  let before = stack[0];
  let after = stack[1];

  if (hasRest(before) || hasRest(after)) {
    return null;
  }

  return after.length - before.length;
}

function hasRest(input: string[]): boolean {
  if (!Array.isArray(input)) {
    throw new Error(`Unexpected stack entry: ${JSON.stringify(input)}`);
  }
  return input.some(s => s.slice(-3) === '...');
}

function operands(input: string[]): OperandList {
  if (!Array.isArray(input)) {
    throw new Error(`Expected operands array, got ${JSON.stringify(input)}`);
  }
  return input.map(op) as OperandList;
}

function op(input: string): Operand {
  let [name, type] = input.split(':');

  if (isOperandType(type)) {
    return { name, type };
  } else {
    throw new Error(`Expected operand, found ${JSON.stringify(input)}`);
  }
}

export function normalizeAll(parsed: {
  machine: Dict<RawOperandMetadata>;
  syscall: Dict<RawOperandMetadata>;
}): { machine: Dict<NormalizedMetadata>; syscall: Dict<NormalizedMetadata> } {
  let machine = normalizeParsed(parsed.machine);
  let syscall = normalizeParsed(parsed.syscall);

  return { machine, syscall };
}

export function normalizeParsed(parsed: Dict<RawOperandMetadata>): Dict<NormalizedMetadata> {
  let out = {};

  for (let key of Object.keys(parsed)) {
    out[key] = normalize(key, parsed[key]);
  }

  return out;
}

export function buildEnum(name: string, parsed: Dict<NormalizedMetadata>): string {
  let e = [`export const enum ${name} {`];

  for (let key of Object.keys(parsed)) {
    e.push(`  ${parsed[key].name},`);
  }

  e.push('  Size,');
  e.push('}');

  return e.join('\n');
}

export const META_KIND = tuple('METADATA', 'MACHINE_METADATA');
export type META_KIND = (typeof META_KIND)[number];

export function buildSingleMeta(
  kind: META_KIND,
  all: Dict<NormalizedMetadata>,
  key: keyof typeof all
): string {
  let e = kind === 'MACHINE_METADATA' ? 'MachineOp' : 'Op';
  return `${kind}[${e}.${all[key].name}] = ${stringify(all[key], 0)};`;
}

function stringify(o: unknown, pad: number): string {
  if (typeof o !== 'object' || o === null) {
    if (typeof o === 'string') {
      return `'${o}'`;
    }
    return JSON.stringify(o);
  }

  if (Array.isArray(o)) {
    return `[${o.map(v => stringify(v, pad)).join(', ')}]`;
  }

  let out = ['{'];

  for (let key of Object.keys(o)) {
    out.push(`${' '.repeat(pad + 2)}${key}: ${stringify(o[key], pad + 2)},`);
  }

  out.push(`${' '.repeat(pad)}}`);

  return out.join('\n');
}

export function buildMetas(kind: META_KIND, all: Dict<NormalizedMetadata>): string {
  let out = [];

  for (let key of Object.keys(all)) {
    out.push(buildSingleMeta(kind, all, key));
  }

  return out.join('\n\n');
}