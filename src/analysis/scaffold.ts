import fs from 'node:fs';
import path from 'node:path';
import { hasSymlinkBetween } from '../lib/paths.js';

export type Stack = 'node' | 'python' | 'go' | 'rust';

export interface ScaffoldInput {
  projectName: string;
  stack: Stack;
  /** Markdown design/blueprint written by the model; becomes docs/BLUEPRINT.md. */
  blueprintMarkdown: string;
  port: number;
}

/** Pure function: returns files to write (relative path -> contents). */
export function renderScaffold(input: ScaffoldInput): Record<string, string> {
  const name = slug(input.projectName);
  const files: Record<string, string> = {
    'README.md': `# ${input.projectName}\n\nScaffolded by ideation-goat. See [docs/BLUEPRINT.md](docs/BLUEPRINT.md) for the design.\n\n## Run with Docker\n\n\`\`\`bash\ncp .env.example .env\ndocker compose up --build\n\`\`\`\n`,
    'docs/BLUEPRINT.md': input.blueprintMarkdown.trim() + '\n',
    '.env.example': `PORT=${input.port}\n`,
    '.gitignore': '.env\nnode_modules/\ndist/\n__pycache__/\n.venv/\ntarget/\n',
    '.dockerignore': '.git\n.env\nnode_modules\ndist\n__pycache__\n.venv\ntarget\n',
    'docker-compose.yml': `services:\n  app:\n    build: .\n    env_file: .env\n    ports:\n      - "\${PORT:-${input.port}}:\${PORT:-${input.port}}"\n    restart: unless-stopped\n`,
    Dockerfile: dockerfile(input.stack, name, input.port),
  };
  Object.assign(files, starter(input.stack, name, input.port));
  return files;
}

function dockerfile(stack: Stack, name: string, port: number): string {
  switch (stack) {
    case 'node':
      return `FROM node:22-alpine AS build\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nRUN npm run build --if-present\n\nFROM node:22-alpine\nWORKDIR /app\nENV NODE_ENV=production\nCOPY package*.json ./\nRUN npm install --omit=dev\nCOPY --from=build /app .\nUSER node\nEXPOSE ${port}\nCMD ["node", "index.js"]\n`;
    case 'python':
      return `FROM python:3.12-slim\nWORKDIR /app\nENV PYTHONUNBUFFERED=1\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nRUN useradd -m app\nUSER app\nEXPOSE ${port}\nCMD ["python", "main.py"]\n`;
    case 'go':
      return `FROM golang:1.23-alpine AS build\nWORKDIR /src\nCOPY go.mod ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /out/app .\n\nFROM gcr.io/distroless/static-debian12\nCOPY --from=build /out/app /app\nEXPOSE ${port}\nENTRYPOINT ["/app"]\n`;
    case 'rust':
      return `FROM rust:1-slim AS build\nWORKDIR /src\nCOPY . .\nRUN cargo build --release\n\nFROM debian:bookworm-slim\nCOPY --from=build /src/target/release/${name} /usr/local/bin/app\nEXPOSE ${port}\nCMD ["app"]\n`;
  }
}

function starter(stack: Stack, name: string, port: number): Record<string, string> {
  switch (stack) {
    case 'node':
      return {
        'package.json': JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node index.js' } }, null, 2) + '\n',
        'index.js': `import http from 'node:http';\n\nconst port = Number(process.env.PORT ?? ${port});\nhttp\n  .createServer((_req, res) => {\n    res.writeHead(200, { 'content-type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));\n  })\n  .listen(port, () => console.log(\`listening on \${port}\`));\n`,
      };
    case 'python':
      return {
        'requirements.txt': '',
        'main.py': `import json\nimport os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\n\n\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200)\n        self.send_header("content-type", "application/json")\n        self.end_headers()\n        self.wfile.write(json.dumps({"status": "ok"}).encode())\n\n\nif __name__ == "__main__":\n    port = int(os.environ.get("PORT", ${port}))\n    HTTPServer(("0.0.0.0", port), Handler).serve_forever()\n`,
      };
    case 'go':
      return {
        'go.mod': `module ${name}\n\ngo 1.23\n`,
        'main.go': `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\tport := os.Getenv("PORT")\n\tif port == "" {\n\t\tport = "${port}"\n\t}\n\thttp.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {\n\t\tw.Header().Set("content-type", "application/json")\n\t\tfmt.Fprint(w, \`{"status":"ok"}\`)\n\t})\n\thttp.ListenAndServe(":"+port, nil)\n}\n`,
      };
    case 'rust':
      return {
        'Cargo.toml': `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
        'src/main.rs': `use std::io::{Read, Write};\nuse std::net::TcpListener;\n\nfn main() {\n    let port = std::env::var("PORT").unwrap_or_else(|_| "${port}".into());\n    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).expect("bind");\n    for stream in listener.incoming().flatten() {\n        let mut stream = stream;\n        let mut buf = [0u8; 1024];\n        let _ = stream.read(&mut buf);\n        let body = r#"{"status":"ok"}"#;\n        let _ = write!(stream, "HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\ncontent-length: {}\\r\\n\\r\\n{}", body.len(), body);\n    }\n}\n`,
      };
  }
}

export function slug(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  // Cargo crate and Go module names must not start with a digit.
  return /^[0-9]/.test(base) ? `app-${base}` : base;
}

/**
 * Write files under `dir`. Refuses to overwrite existing files unless
 * `overwrite` is set; on failure, removes the files it created.
 */
export function writeFiles(dir: string, files: Record<string, string>, overwrite: boolean): { created: string[] } {
  const exists = (p: string) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  for (const rel of Object.keys(files)) {
    if (hasSymlinkBetween(dir, path.join(dir, rel))) throw new Error(`Refusing to write '${rel}': the path contains a symlink.`);
  }
  const existing = Object.keys(files).filter((f) => exists(path.join(dir, f)));
  if (existing.length && !overwrite) {
    throw new Error(`Refusing to overwrite existing files: ${existing.join(', ')}. Pass overwrite=true or choose an empty directory.`);
  }
  const created: string[] = [];
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (hasSymlinkBetween(dir, target)) throw new Error(`Refusing to write '${rel}': the path contains a symlink.`);
      // O_NOFOLLOW closes the race between the check above and the write (no-op on Windows).
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
      try {
        fs.writeFileSync(fd, content, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      created.push(rel);
    }
  } catch (err) {
    for (const rel of created) if (!existing.includes(rel)) fs.rmSync(path.join(dir, rel), { force: true });
    throw err;
  }
  return { created };
}
