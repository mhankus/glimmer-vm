import { Ops } from '../../../wire-format';
import * as WireFormat from '@glimmer/wire-format';
import OpcodeBuilder from '../compiled/opcodes/builder';
import { CompiledExpression } from '../compiled/expressions';
import CompiledHasBlock, { CompiledHasBlockParams } from '../compiled/expressions/has-block';
import { BaselineSyntax, InlineBlock } from '../scanner';
import {
  CompiledInPartialGetBlock
} from '../compiled/expressions/has-block';
import { PublicVM as VM } from '../vm';
import AppendVM from '../vm/append';

import {
  EMPTY_ARRAY
} from '../utils';

import {
  LOGGER,
  Opaque,
  Option,
  dict,
  assert,
  unwrap,
  unreachable
} from '@glimmer/util';

export type SexpExpression = BaselineSyntax.AnyExpression & { 0: number };
export type Syntax = SexpExpression | BaselineSyntax.AnyStatement;
export type CompilerFunction<T extends Syntax, U> = ((sexp: T, builder: OpcodeBuilder) => U);
export type Name = BaselineSyntax.AnyStatement[0];
export type debugGet = ((path: string) => any);

export interface DebugContext {
  context: Opaque;
  get: debugGet;
}

export type debugCallback = ((context: Opaque, get: debugGet) => DebugContext);

function debugCallback(context: Opaque, get: debugGet) {
  console.info('Use `context`, and `get(<path>)` to debug this template.');
  /* tslint:disable */
  debugger;
  /* tslint:enable */
  return { context, get };
}

function getter(vm: VM, builder: OpcodeBuilder) {
  return (path: string) => {
    let parts = path.split('.') as any;

    if (parts[0] === 'this') {
      parts[0] = null;
    }

    return compileRef(parts, builder).evaluate(vm as AppendVM);
  };
}

let callback = debugCallback;

// For testing purposes
export function setDebuggerCallback(cb: debugCallback) {
  callback = cb;
}

export function resetDebuggerCallback() {
  callback = debugCallback;
}

export class Compilers<T extends Syntax, CompileTo> {
  private names = dict<number>();
  private funcs: CompilerFunction<T, CompileTo>[] = [];

  add(name: number, func: CompilerFunction<T, CompileTo>): void {
    this.funcs.push(func);
    this.names[name] = this.funcs.length - 1;
  }

  compile(sexp: T, builder: OpcodeBuilder): CompileTo {
    let name: number = sexp[0];
    let index = this.names[name];
    let func = this.funcs[index];
    assert(!!func, `expected an implementation for ${sexp[0]}`);
    return func(sexp, builder);
  }
}

import S = WireFormat.Statements;

export const STATEMENTS = new Compilers<BaselineSyntax.AnyStatement, void>();

STATEMENTS.add(Ops.Text, (sexp: S.Text, builder: OpcodeBuilder) => {
  builder.text(sexp[1]);
});

STATEMENTS.add(Ops.Comment, (sexp: S.Comment, builder: OpcodeBuilder) => {
  builder.comment(sexp[1]);
});

STATEMENTS.add(Ops.CloseElement, (_sexp, builder: OpcodeBuilder) => {
  LOGGER.trace('close-element statement');
  builder.closeElement();
});

STATEMENTS.add(Ops.FlushElement, (_sexp, builder: OpcodeBuilder) => {
  builder.flushElement();
});

STATEMENTS.add(Ops.Modifier, (sexp: S.Modifier, builder: OpcodeBuilder) => {
  let [, path, params, hash] = sexp;

  let args = compileArgs(params, hash, builder);

  if (builder.env.hasModifier(path, builder.symbolTable)) {
    builder.modifier(path[0], args);
  } else {
    throw new Error(`Compile Error ${path.join('.')} is not a modifier: Helpers may not be used in the element form.`);
  }
});

STATEMENTS.add(Ops.StaticAttr, (sexp: S.StaticAttr, builder: OpcodeBuilder) => {
  let [, name, value, namespace] = sexp;
  builder.staticAttr(name, namespace, value as string);
});

STATEMENTS.add(Ops.AnyDynamicAttr, (sexp: BaselineSyntax.AnyDynamicAttr, builder: OpcodeBuilder) => {
  let [, name, value, namespace, trusting] = sexp;

  expr(value, builder);

  if (namespace) {
    builder.dynamicAttrNS(name, namespace, trusting);
  } else {
    builder.dynamicAttr(name, trusting);
  }
});

STATEMENTS.add(Ops.OpenElement, (sexp: BaselineSyntax.OpenPrimitiveElement, builder: OpcodeBuilder) => {
  LOGGER.trace('open-element statement');
  builder.openPrimitiveElement(sexp[1]);
});

STATEMENTS.add(Ops.OptimizedAppend, (sexp: BaselineSyntax.OptimizedAppend, builder: OpcodeBuilder) => {
  let [, value, trustingMorph] = sexp;

  let { inlines } = builder.env.macros();
  let returned = inlines.compile(sexp, builder) || value;

  if (returned === true) return;

  expr(value, builder);

  if (trustingMorph) {
    builder.trustingAppend();
  } else {
    builder.cautiousAppend();
  }
});

STATEMENTS.add(Ops.UnoptimizedAppend, (sexp: BaselineSyntax.UnoptimizedAppend, builder) => {
  let [, value, trustingMorph] = sexp;

  let { inlines } = builder.env.macros();
  let returned = inlines.compile(sexp, builder) || value;

  if (returned === true) return;

  if (trustingMorph) {
    builder.guardedTrustingAppend(returned[1]);
  } else {
    builder.guardedCautiousAppend(returned[1]);
  }
});

STATEMENTS.add(Ops.NestedBlock, (sexp: BaselineSyntax.NestedBlock, builder: OpcodeBuilder) => {
  let { blocks } = builder.env.macros();
  blocks.compile(sexp, builder);
});

STATEMENTS.add(Ops.ScannedBlock, (sexp: BaselineSyntax.ScannedBlock, builder) => {
  let [, path, params, hash, template, inverse] = sexp;

  let templateBlock = template && template.scan();
  let inverseBlock = inverse && inverse.scan();

  let { blocks } = builder.env.macros();
  blocks.compile([Ops.NestedBlock, path, params, hash, templateBlock, inverseBlock], builder);
});

STATEMENTS.add(Ops.ScannedComponent, (sexp: BaselineSyntax.ScannedComponent, builder) => {
  let [, tag, attrs, rawArgs, rawBlock] = sexp;
  let block = rawBlock && rawBlock.scan();

  let definition = builder.env.getComponentDefinition([tag], builder.symbolTable);
  builder.putComponentDefinition(definition);
  compileList(rawArgs && rawArgs[1], builder);
  compileBlocks(block, null, builder);
  builder.pushReifiedArgs(0, rawArgs ? rawArgs[0] : EMPTY_ARRAY, !!block, false);

  builder.openComponent(attrs.scan());
  builder.closeComponent();
});

STATEMENTS.add(Ops.StaticPartial, (sexp: BaselineSyntax.StaticPartial, builder) => {
  let [, name] = sexp;

  if (!builder.env.hasPartial(name, builder.symbolTable)) {
    throw new Error(`Compile Error: Could not find a partial named "${name}"`);
  }

  let definition = builder.env.lookupPartial(name, builder.symbolTable);

  builder.putPartialDefinition(definition);
  builder.evaluatePartial();
});

STATEMENTS.add(Ops.DynamicPartial, (sexp: BaselineSyntax.DynamicPartial, builder) => {
  let [, name] = sexp;

    builder.startLabels();

    builder.putValue(name);
    builder.test('simple');
    builder.enter('BEGIN', 'END');
    builder.label('BEGIN');
    builder.jumpUnless('END');
    builder.putDynamicPartialDefinition();
    builder.evaluatePartial();
    builder.label('END');
    builder.exit();

    builder.stopLabels();
});

STATEMENTS.add(Ops.Yield, function(this: undefined, sexp: WireFormat.Statements.Yield, builder) {
  let [, to, params] = sexp;

  if (params) compileList(params, builder);
  builder.yield(params ? params.length : 0, to);
});

STATEMENTS.add(Ops.Debugger, (sexp: BaselineSyntax.Debugger, builder: OpcodeBuilder) => {

  builder.putValue([Ops.Function, (vm: VM) => {
    let context = vm.getSelf().value();
    let get = (path: string) => {
      return getter(vm, builder)(path).value();
    };
    callback(context, get);
  }]);

  return sexp;
});

let EXPRESSIONS = new Compilers<SexpExpression, CompiledExpression<Opaque> | void>();

import E = WireFormat.Expressions;
import C = WireFormat.Core;

export function expr(expression: BaselineSyntax.AnyExpression, builder: OpcodeBuilder): void {
  if (Array.isArray(expression)) {
    EXPRESSIONS.compile(expression, builder);
  } else {
    builder.primitive(expression);
  }
}

EXPRESSIONS.add(Ops.Unknown, (sexp: E.Unknown, builder: OpcodeBuilder) => {
  let path = sexp[1];

  if (builder.env.hasHelper(path, builder.symbolTable)) {
    EXPRESSIONS.compile([Ops.Helper, path, EMPTY_ARRAY, null], builder);
  } else {
    compilePath(path, builder);
  }
});

EXPRESSIONS.add(Ops.Concat, ((sexp: E.Concat, builder: OpcodeBuilder) => {
  let parts = sexp[1];
  parts.forEach(p => expr(p, builder));
  builder.concat(parts.length);
}) as any);

EXPRESSIONS.add(Ops.Function, (sexp: BaselineSyntax.FunctionExpression, builder: OpcodeBuilder) => {
  builder.function(sexp[1]);
});

EXPRESSIONS.add(Ops.Helper, (sexp: E.Helper, builder: OpcodeBuilder) => {
  let { env, symbolTable } = builder;
  let [, path, params, hash] = sexp;

  if (env.hasHelper(path, symbolTable)) {
    compileArgs(params, hash, builder);
    builder.pushReifiedArgs(params ? params.length : 0, hash ? hash[0] : EMPTY_ARRAY);
    builder.helper(env.lookupHelper(path, symbolTable));
  } else {
    throw new Error(`Compile Error: ${path.join('.')} is not a helper`);
  }
});

EXPRESSIONS.add(Ops.Get, (sexp: E.Get, builder: OpcodeBuilder) => {
  // TODO: More triage in the precompiler
  compilePath(sexp[1], builder);
});

EXPRESSIONS.add(Ops.Undefined, (_sexp, builder) => {
  return builder.primitive(undefined);
});

EXPRESSIONS.add(Ops.Arg, (sexp: E.Arg, builder: OpcodeBuilder) => {
  let [, parts] = sexp;
  let head = parts[0];
  let named: Option<number>, partial: Option<number>;
  let path: string[];

  if (named = builder.symbolTable.getSymbol('named', head)) {
    builder.getVariable(named);
    path = parts.slice(1);
  } else if (partial = builder.symbolTable.getPartialArgs()) {
    throw new Error("TODO: Partial");
  } else {
    throw new Error(`[BUG] @${parts.join('.')} is not a valid lookup path.`);
  }

  path.forEach(p => builder.getProperty(p));
});

EXPRESSIONS.add(Ops.HasBlock, (sexp: E.HasBlock, builder) => {
  let blockName = sexp[1];

  let yields: Option<number>, partial: Option<number>;

  if (yields = builder.symbolTable.getSymbol('yields', blockName)) {
    builder.hasBlock(blockName);
  } else if (partial = builder.symbolTable.getPartialArgs()) {
    let inner = new CompiledInPartialGetBlock(partial, blockName);
    return new CompiledHasBlock(inner);
  } else {
    throw new Error('[BUG] ${blockName} is not a valid block name.');
  }
});

EXPRESSIONS.add(Ops.HasBlockParams, (sexp: E.HasBlockParams, builder) => {
  let blockName = sexp[1];
  let yields: Option<number>, partial: Option<number>;

  if (yields = builder.symbolTable.getSymbol('yields', blockName)) {
    builder.hasBlockParams(blockName);
  } else if (partial = builder.symbolTable.getPartialArgs()) {
    let inner = new CompiledInPartialGetBlock(partial, blockName);
    return new CompiledHasBlockParams(inner);
  } else {
    throw new Error('[BUG] ${blockName} is not a valid block name.');
  }

});

export function compileArgs(params: Option<WireFormat.Core.Params>, hash: Option<WireFormat.Core.Hash>, builder: OpcodeBuilder): { positional: number, named: number } {
  let positional = params ? params.length : 0;
  let named = hash ? hash.length : 0;
  if (params) compileList(params, builder);
  if (hash) compileList(hash[1], builder);

  return { positional, named };
}

export function compileList(params: Option<WireFormat.Core.Expression[]>, builder: OpcodeBuilder) {
  if (!params) return;
  params.forEach(p => expr(p, builder));
}

const EMPTY_BLOCKS = { default: false, inverse: false };

export function compileBlocks(block: Option<InlineBlock>, inverse: Option<InlineBlock>, builder: OpcodeBuilder): { default: boolean, inverse: boolean } {
  if (!block && !inverse) return EMPTY_BLOCKS;
  builder.pushBlocks(block, inverse);
  return { default: !!block, inverse: !!inverse };
}

function compilePath(parts: string[], builder: OpcodeBuilder) {
  let head = parts[0];
  let local: Option<number>;
  let path: string[];

  if (head === null) { // {{this.foo}}
    builder.self();
    path = parts.slice(1);
  } else if (local = builder.symbolTable.getSymbol('local', head)) {
    builder.getVariable(local);
    path = parts.slice(1);
  } else {
    builder.self();
    path = parts;
  }

  path.forEach(p => builder.getProperty(p));
}

export type NestedBlockSyntax = BaselineSyntax.NestedBlock;
export type CompileBlockMacro = (sexp: NestedBlockSyntax, builder: OpcodeBuilder) => void;

export class Blocks {
  private names = dict<number>();
  private funcs: CompileBlockMacro[] = [];
  private missing: CompileBlockMacro;

  add(name: string, func: CompileBlockMacro) {
    this.funcs.push(func);
    this.names[name] = this.funcs.length - 1;
  }

  addMissing(func: CompileBlockMacro) {
    this.missing = func;
  }

  compile(sexp: BaselineSyntax.NestedBlock, builder: OpcodeBuilder): void {
    // assert(sexp[1].length === 1, 'paths in blocks are not supported');

    let name: string = sexp[1][0];
    let index = this.names[name];

    if (index === undefined) {
      assert(!!this.missing, `${name} not found, and no catch-all block handler was registered`);
      let func = this.missing;
      let handled = func(sexp, builder);
      assert(!!handled, `${name} not found, and the catch-all block handler didn't handle it`);
    } else {
      let func = this.funcs[index];
      func(sexp, builder);
    }
  }
}

export const BLOCKS = new Blocks();

export type AppendSyntax = BaselineSyntax.OptimizedAppend | BaselineSyntax.UnoptimizedAppend;
export type AppendMacro = (path: C.Path, params: Option<C.Params>, hash: Option<C.Hash>, builder: OpcodeBuilder) => ['expr', BaselineSyntax.AnyExpression] | true | false;

export class Inlines {
  private names = dict<number>();
  private funcs: AppendMacro[] = [];
  private missing: AppendMacro;

  add(name: string, func: AppendMacro) {
    this.funcs.push(func);
    this.names[name] = this.funcs.length - 1;
  }

  addMissing(func: AppendMacro) {
    this.missing = func;
  }

  compile(sexp: AppendSyntax, builder: OpcodeBuilder): ['expr', BaselineSyntax.AnyExpression] | true {
    let value = sexp[1];

    // TODO: Fix this so that expression macros can return
    // things like components, so that {{component foo}}
    // is the same as {{(component foo)}}

    if (!Array.isArray(value)) return ['expr', value];

    let path: C.Path;
    let params: Option<C.Params>;
    let hash: Option<C.Hash>;

    if (value[0] === Ops.Helper) {
      path = value[1];
      params = value[2];
      hash = value[3];
    } else if (value[0] === Ops.Unknown) {
      path = value[1];
      params = hash = null;
    } else {
      return ['expr', value];
    }


    if (path.length > 1) return ['expr', value];

    let name = path[0];
    let index = this.names[name];

    if (index === undefined && this.missing) {
      let func = this.missing;
      let returned = func(path, params, hash, builder);
      return returned === false ? ['expr', value] : returned;
    } else if (index !== undefined) {
      let func = this.funcs[index];
      let returned = func(path, params, hash, builder);
      return returned === false ? ['expr', value] : returned;
    } else {
      return ['expr', value];
    }
  }
}

export const INLINES = new Inlines();

populateBuiltins(BLOCKS, INLINES);

export function populateBuiltins(blocks: Blocks = new Blocks(), inlines: Inlines = new Inlines()): { blocks: Blocks, inlines: Inlines } {
  blocks.add('if', (sexp: BaselineSyntax.NestedBlock, builder: OpcodeBuilder) => {
    //        PutArgs
    //        Test(Environment)
    //        Enter(BEGIN, END)
    // BEGIN: Noop
    //        JumpUnless(ELSE)
    //        Evaluate(default)
    //        Jump(END)
    // ELSE:  Noop
    //        Evalulate(inverse)
    // END:   Noop
    //        Exit

    let [,, params,, _default, inverse] = sexp;

    if (!params) {
      throw new Error(`SYNTAX ERROR: #if requires an argument`);
    }

    let condition = builder.local();
    expr(params[0], builder);
    builder.setLocal(condition);

    builder.getLocal(condition);
    builder.test('environment');

    builder.labelled(b => {
      if (_default && inverse) {
        b.jumpUnless('ELSE');
        b.evaluate(_default, [builder.GetLocal(condition)]);
        b.jump('END');
        b.label('ELSE');
        b.evaluate(inverse, null);
      } else if (_default) {
        b.jumpUnless('END');
        b.evaluate(_default, [builder.GetLocal(condition)]);
      } else {
        throw unreachable();
      }
    });
  });

  blocks.add('unless', (sexp: BaselineSyntax.NestedBlock, builder: OpcodeBuilder) => {
    //        PutArgs
    //        Test(Environment)
    //        Enter(BEGIN, END)
    // BEGIN: Noop
    //        JumpUnless(ELSE)
    //        Evaluate(default)
    //        Jump(END)
    // ELSE:  Noop
    //        Evalulate(inverse)
    // END:   Noop
    //        Exit

    let [,, params,, _default, inverse] = sexp;

    if (!params) {
      throw new Error(`SYNTAX ERROR: #if requires an argument`);
    }

    let condition = builder.local();
    expr(params[0], builder);
    builder.setLocal(condition);

    builder.getLocal(condition);
    builder.test('environment');

    builder.labelled(b => {
      if (_default && inverse) {
        b.jumpIf('ELSE');
        b.evaluate(_default, [builder.GetLocal(condition)]);
        b.jump('END');
        b.label('ELSE');
        b.evaluate(inverse, null);
      } else if (_default) {
        b.jumpIf('END');
        b.evaluate(_default, [builder.GetLocal(condition)]);
      } else {
        throw unreachable();
      }
    });
  });

  blocks.add('with', (sexp: BaselineSyntax.NestedBlock, builder: OpcodeBuilder) => {
    //        PutArgs
    //        Test(Environment)
    //        Enter(BEGIN, END)
    // BEGIN: Noop
    //        JumpUnless(ELSE)
    //        Evaluate(default)
    //        Jump(END)
    // ELSE:  Noop
    //        Evalulate(inverse)
    // END:   Noop
    //        Exit

    let [,, params,, _default, inverse] = sexp;

    if (!params) {
      throw new Error(`SYNTAX ERROR: #if requires an argument`);
    }

    let condition = builder.local();
    expr(params[0], builder);
    builder.setLocal(condition);

    builder.getLocal(condition);
    builder.test('environment');

    builder.labelled(b => {
      if (_default && inverse) {
        b.jumpUnless('ELSE');
        builder.getLocal(condition);
        b.evaluate(_default, [builder.GetLocal(condition)]);
        b.jump('END');
        b.label('ELSE');
        b.evaluate(inverse, null);
      } else if (_default) {
        b.jumpUnless('END');
        b.evaluate(_default, [builder.GetLocal(condition)]);
      } else {
        throw unreachable();
      }
    });
  });

  blocks.add('each', (sexp: BaselineSyntax.NestedBlock, builder: OpcodeBuilder) => {
    //         Enter(BEGIN, END)
    // BEGIN:  Noop
    //         PutArgs
    //         PutIterable
    //         JumpUnless(ELSE)
    //         EnterList(BEGIN2, END2)
    // ITER:   Noop
    //         NextIter(BREAK)
    //         EnterWithKey(BEGIN2, END2)
    // BEGIN2: Noop
    //         PushChildScope
    //         Evaluate(default)
    //         PopScope
    // END2:   Noop
    //         Exit
    //         Jump(ITER)
    // BREAK:  Noop
    //         ExitList
    //         Jump(END)
    // ELSE:   Noop
    //         Evalulate(inverse)
    // END:    Noop
    //         Exit

    // TOMORROW: Locals for key, value, memo
    // TOMORROW: What is the memo slot used for?

    let [,, params, hash, _default, inverse] = sexp;

    let list = builder.local();

    if (hash && hash[0][0] === 'key') {
      expr(hash[1][0], builder);
    } else {
      throw new Error('Compile error: #each without key');
    }

    expr(params[0], builder);
    builder.setLocal(list);
    builder.getLocal(list);

    builder.labelled(b => {
      b.putIterator();

      if (inverse) {
        b.jumpUnless('ELSE');
      } else {
        b.jumpUnless('END');
      }

      b.iter(b => {
        b.evaluate(unwrap(_default), 2);
      });

      if (inverse) {
        b.jump('END');
        b.label('ELSE');
        b.evaluate(inverse, null);
      }
    });

    // pop the iterator that is at the top of the stack
    // throughout this process.
    builder.pop();
  });

  return { blocks, inlines };
}
