import { render, Text, useApp, useInput, type Key } from "ink";
import { createElement, useRef, useState } from "react";

function Keyboard({ handlerRef }: { handlerRef: { current: (v: string, k: Key) => void } }) {
  useInput((value, key) => handlerRef.current(value, key));
  return null;
}

function Probe() {
  const { exit } = useApp();
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef(log);
  logRef.current = log;
  const handler = (value: string, key: Key): void => {
    const desc = key.return ? "RETURN" : key.ctrl ? `CTRL(${JSON.stringify(value)})` : JSON.stringify(value);
    setLog((l) => [...l, desc]);
  };
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  return (
    <>
      <Keyboard handlerRef={handlerRef} />
      <Text>keys: {logRef.current.join(" ") || "(none yet)"}</Text>
    </>
  );
}

render(createElement(Probe), { exitOnCtrlC: false, patchConsole: false });
