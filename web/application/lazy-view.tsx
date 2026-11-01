import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";

class ModuleBoundary extends Component<{ children: ReactNode; fallback: (error: Error) => ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

// React lazy with a fresh import attempt after a failed chunk load. This replaces
// the client-only portion of Next dynamic without importing a framework runtime.
export function lazyView<P extends object>(loader: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>, options: { loading: ComponentType<{ error?: Error; retry?: () => void }> }) {
  const make = () => lazy(async () => {
    const module = await loader();
    return typeof module === "function" ? { default: module } : module as { default: ComponentType<P> };
  });
  // Share React's resolved lazy payload across screen remounts. A new lazy type
  // would suspend again on the same cached module and delay a warm navigation.
  let InitialView = make();
  return function LazyView(props: P) {
    const [attempt, setAttempt] = useState(0);
    const [View, setView] = useState(() => InitialView);
    const Loading = options.loading;
    return <ModuleBoundary key={attempt} fallback={error => <Loading error={error} retry={() => { InitialView = make(); setView(() => InitialView); setAttempt(value => value + 1); }}/>}>
      <Suspense fallback={<Loading/>}><View {...props}/></Suspense>
    </ModuleBoundary>;
  };
}
