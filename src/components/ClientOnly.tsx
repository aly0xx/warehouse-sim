"use client";

import dynamic from "next/dynamic";

// three.js / WebGL needs the browser — skip server prerendering.
const Simulator = dynamic(() => import("./Simulator"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-[#0b1226] text-sm text-sky-300">
      Loading warehouse…
    </div>
  ),
});

export default function ClientOnly() {
  return <Simulator />;
}
