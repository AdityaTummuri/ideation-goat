export interface FootprintSignals {
  rootFiles: string[];
  cargoToml?: string | null;
  sampleHeader?: string | null;
  repoSizeKb: number;
}

export interface FootprintEstimate {
  ecosystem: string;
  sramKb: { low: number; high: number };
  flashKb: { low: number; high: number };
  findings: string[];
  confidence: 'low';
  method: string;
}

/**
 * Order-of-magnitude RAM/flash guess from repository structure. This does not
 * compile anything; only a real build (`size` on the ELF) gives true numbers.
 */
export function estimateFootprint(s: FootprintSignals): FootprintEstimate {
  const files = s.rootFiles.map((f) => f.toLowerCase());
  const findings: string[] = [];
  let ecosystem = 'Unknown';
  let sram = { low: 20, high: 200 };
  let flash = { low: 50, high: 500 };

  if (files.includes('cargo.toml')) {
    ecosystem = 'Rust';
    if (s.cargoToml && /no_std|embedded-hal|cortex-m|esp-hal|embassy/i.test(s.cargoToml)) {
      sram = { low: 4, high: 64 };
      flash = { low: 16, high: 256 };
      findings.push('Cargo.toml references no_std/embedded crates: bare-metal capable.');
    } else {
      sram = { low: 256, high: 4096 };
      flash = { low: 512, high: 8192 };
      findings.push('No embedded markers in Cargo.toml; assumes std (needs an OS-class target such as ESP-IDF or Linux).');
    }
  } else if (files.includes('platformio.ini') || files.some((f) => f.endsWith('.ino'))) {
    ecosystem = 'Arduino / PlatformIO (C++)';
    sram = { low: 2, high: 64 };
    flash = { low: 8, high: 512 };
    findings.push('Arduino/PlatformIO project: built for microcontrollers.');
  } else if (files.includes('cmakelists.txt') || files.includes('makefile') || files.some((f) => /\.(c|h|cpp|hpp)$/.test(f))) {
    ecosystem = 'C/C++';
    if (s.sampleHeader && /#include\s*<(vector|string|map|iostream|memory)>/.test(s.sampleHeader)) {
      sram = { low: 32, high: 256 };
      flash = { low: 128, high: 1024 };
      findings.push('Headers include STL containers: dynamic allocation and code-size overhead likely.');
    } else {
      sram = { low: 2, high: 64 };
      flash = { low: 8, high: 256 };
      findings.push('No STL usage seen in the sampled header.');
    }
  } else if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('setup.py')) {
    ecosystem = 'Python';
    sram = { low: 128, high: 1024 };
    flash = { low: 512, high: 2048 };
    findings.push('Python: needs MicroPython/CircuitPython on an MCU, and CPython libraries usually do not port as-is.');
  } else if (files.includes('package.json')) {
    ecosystem = 'JavaScript';
    sram = { low: 64, high: 512 };
    flash = { low: 256, high: 2048 };
    findings.push('JavaScript: needs an embedded engine (Espruino, JerryScript, Moddable); npm packages rarely run unmodified.');
  }

  if (s.repoSizeKb > 50_000) findings.push(`Repository is ${(s.repoSizeKb / 1024).toFixed(0)} MB; much of it may be docs/assets, but large codebases tend to produce larger binaries.`);

  return {
    ecosystem,
    sramKb: sram,
    flashKb: flash,
    findings,
    confidence: 'low',
    method: 'Heuristic from repository root files and one sampled header; no compilation.',
  };
}
