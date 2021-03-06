import {
  Bounds,
  WithJitStaticLayout,
  WithAotStaticLayout,
  AotRuntimeResolver,
  JitRuntimeResolver,
  Environment,
  CompilableProgram,
  Invocation,
  ComponentCapabilities,
} from '@glimmer/interfaces';
import { TestComponentDefinitionState } from './test-component';
import { unreachable, expect } from '@glimmer/util';
import { VersionedPathReference, UpdatableRootReference } from '@glimmer/reference';
import { Tag, CONSTANT_TAG } from '@glimmer/validator';
import { unwrapTemplate } from '@glimmer/opcode-compiler';

export interface BasicComponentFactory {
  new (): BasicComponent;
}

export class BasicComponent {
  public element!: Element;
  public bounds!: Bounds;
}

export class BasicComponentManager
  implements
    WithJitStaticLayout<BasicComponent, TestComponentDefinitionState, JitRuntimeResolver>,
    WithAotStaticLayout<BasicComponent, TestComponentDefinitionState, AotRuntimeResolver> {
  getCapabilities(state: TestComponentDefinitionState): ComponentCapabilities {
    return state.capabilities;
  }

  prepareArgs(): null {
    throw unreachable();
  }

  create(_env: Environment, definition: TestComponentDefinitionState): BasicComponent {
    let klass = definition.ComponentClass || BasicComponent;
    return new klass();
  }

  getJitStaticLayout(
    state: TestComponentDefinitionState,
    resolver: JitRuntimeResolver
  ): CompilableProgram {
    return unwrapTemplate(resolver.compilable(state.locator)).asLayout();
  }

  getAotStaticLayout(
    state: TestComponentDefinitionState,
    resolver: AotRuntimeResolver
  ): Invocation {
    // For the case of dynamically invoking (via `{{component}}`) in eager
    // mode, we need to exchange the module locator for the handle to the
    // compiled layout (which was provided at bundle compilation time and
    // stashed in the component definition state).
    let locator = expect(state.locator, 'component definition state should include module locator');
    return resolver.getInvocation(locator);
  }

  getSelf(component: BasicComponent): VersionedPathReference {
    return new UpdatableRootReference(component);
  }

  getTag(): Tag {
    return CONSTANT_TAG;
  }

  didCreateElement(component: BasicComponent, element: Element): void {
    component.element = element;
  }

  didRenderLayout(component: BasicComponent, bounds: Bounds): void {
    component.bounds = bounds;
  }

  didCreate(): void {}

  update(): void {}

  didUpdateLayout(): void {}

  didUpdate(): void {}

  getDestructor(): null {
    return null;
  }
}
