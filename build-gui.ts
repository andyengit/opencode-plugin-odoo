import { build } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

await build({ root: import.meta.dir, configFile: false, logLevel: "info", plugins: gui() })
