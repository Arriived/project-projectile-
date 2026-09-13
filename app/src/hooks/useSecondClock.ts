// A boundary-aligned UNIX-second clock for the 1S chart. It lives outside render so an
// unrelated render cannot manufacture a new timestamp and reset the chart series.

import { useEffect, useState } from "react";

const SECOND_MS = 1_000;
const flooredNow = (): number => Math.floor(Date.now() / SECOND_MS);

export function useSecondClock(): number {
  const [now, setNow] = useState(flooredNow);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setNow(flooredNow());
        schedule();
      }, SECOND_MS - (Date.now() % SECOND_MS) + 20);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}
