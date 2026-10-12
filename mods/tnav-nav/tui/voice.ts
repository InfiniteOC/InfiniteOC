import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

// Local dictation: record with ffmpeg or sox, transcribe with a whisper CLI that is already installed.
// Nothing is installed or downloaded, and audio never leaves the machine.

const WHISPER = ["whisper-cli", "whisper-cpp", "whisper.cpp", "whisper"]
const MODEL_DIRS = [".cache/whisper.cpp", ".cache/whisper", "whisper.cpp/models", ".local/share/whisper.cpp", ".local/share/whisper"]
const SYSTEM_MODEL_DIRS = ["/opt/homebrew/share/whisper-cpp", "/usr/local/share/whisper-cpp", "/usr/share/whisper.cpp", "/opt/homebrew/share/whisper.cpp"]

export type Which = (name: string) => string | undefined

export const which: Which = (name) => {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.split("\n")[0]?.trim() || undefined : undefined
}

export type Setup =
  | { ok: true; whisper: string; flavor: "cpp" | "python"; model?: string; recorder: "ffmpeg" | "sox"; recorderPath: string }
  | { ok: false; message: string }

/** Finds a ggml model: INFINITEOC_WHISPER_MODEL, else the first ggml-*.bin in a well-known folder (base before tiny before bigger). */
export function findModel(env: Record<string, string | undefined> = process.env, home = homedir(), exists = existsSync, list = (dir: string) => readdirSync(dir)) {
  if (env.INFINITEOC_WHISPER_MODEL) return exists(env.INFINITEOC_WHISPER_MODEL) ? env.INFINITEOC_WHISPER_MODEL : undefined
  for (const dir of [...MODEL_DIRS.map((entry) => path.join(home, entry)), ...SYSTEM_MODEL_DIRS]) {
    if (!exists(dir)) continue
    const models = list(dir).filter((name) => /^ggml-.*\.bin$/.test(name) && !name.includes("for-tests"))
    const rank = (name: string) => ["base", "tiny", "small", "medium", "large"].findIndex((size) => name.includes(size))
    models.sort((a, b) => (rank(a) < 0 ? 9 : rank(a)) - (rank(b) < 0 ? 9 : rank(b)) || a.localeCompare(b))
    if (models[0]) return path.join(dir, models[0])
  }
}

export function detect(find: Which = which, env: Record<string, string | undefined> = process.env, model = () => findModel(env)): Setup {
  const whisper = WHISPER.map((name) => ({ name, path: find(name) })).find((entry) => entry.path)
  if (!whisper?.path)
    return { ok: false, message: "Voice input needs a local whisper CLI (whisper-cli from whisper.cpp, or the whisper Python tool) on PATH. Nothing is installed automatically; install one and run /voice again." }
  const recorder = ["ffmpeg", "sox"].map((name) => ({ name: name as "ffmpeg" | "sox", path: find(name) })).find((entry) => entry.path)
  if (!recorder?.path) return { ok: false, message: `Found ${whisper.name} but no recorder. Install ffmpeg or sox so /voice can capture the microphone.` }
  const flavor = whisper.name === "whisper" ? "python" : "cpp"
  const found = flavor === "cpp" ? model() : undefined
  if (flavor === "cpp" && !found)
    return { ok: false, message: `Found ${whisper.name} but no ggml model. Put a ggml-*.bin model in ~/.cache/whisper.cpp or set INFINITEOC_WHISPER_MODEL to its path.` }
  return { ok: true, whisper: whisper.path, flavor, model: found, recorder: recorder.name, recorderPath: recorder.path }
}

export function recordArgs(recorder: "ffmpeg" | "sox", file: string, platform = process.platform) {
  if (recorder === "sox") return ["-q", "-d", "-r", "16000", "-c", "1", "-b", "16", file]
  const input = platform === "darwin" ? ["-f", "avfoundation", "-i", ":default"] : platform === "win32" ? ["-f", "dshow", "-i", "audio=default"] : ["-f", "pulse", "-i", "default"]
  return ["-hide_banner", "-loglevel", "error", "-y", ...input, "-ac", "1", "-ar", "16000", file]
}

export function transcribeArgs(setup: Extract<Setup, { ok: true }>, file: string, outDir: string) {
  return setup.flavor === "python"
    ? ["--model", "base", "--output_format", "txt", "--output_dir", outDir, file]
    : ["-m", setup.model!, "-f", file, "-nt", "-np"]
}

/** Text of a transcription: whisper.cpp prints it on stdout; the python tool writes <name>.txt. */
export function cleanTranscript(stdout: string) {
  return stdout
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
}

export type Recording = { stop(): Promise<string>; cancel(): void }

/** Starts recording. `stop()` ends it cleanly and resolves with the transcript. Throws if the recorder dies at once. */
export async function startRecording(setup: Extract<Setup, { ok: true }>): Promise<Recording> {
  const dir = mkdtempSync(path.join(tmpdir(), "infiniteoc-voice-"))
  const file = path.join(dir, "speech.wav")
  const recorder: ChildProcess = spawn(setup.recorderPath, recordArgs(setup.recorder, file), { stdio: ["ignore", "ignore", "pipe"] })
  let error = ""
  recorder.stderr?.on("data", (chunk) => (error += String(chunk)))
  const exited = new Promise<number | null>((resolve) => recorder.once("close", resolve))
  const early = await Promise.race([exited, new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 700))])
  if (early !== "running") {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(error.trim().split("\n").pop() || `${setup.recorder} exited with code ${early}`)
  }
  return {
    cancel() {
      recorder.kill("SIGKILL")
      rmSync(dir, { recursive: true, force: true })
    },
    async stop() {
      try {
        recorder.kill("SIGINT")
        await exited
        if (!existsSync(file) || statSync(file).size < 2000) throw new Error("No audio was captured")
        const run = spawnSync(setup.whisper, transcribeArgs(setup, file, dir), { encoding: "utf8", timeout: 120_000 })
        if (run.error || run.status !== 0) throw new Error(run.error?.message ?? (run.stderr.trim().split("\n").pop() || `whisper exited with code ${run.status}`))
        const txt = path.join(dir, "speech.txt")
        return cleanTranscript(setup.flavor === "python" && existsSync(txt) ? readFileSync(txt, "utf8") : run.stdout)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
