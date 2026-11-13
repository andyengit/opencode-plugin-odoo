import { Plugin } from "@opencode/plugin/gui"
import en from "./gui/i18n/en"
import main from "./gui/main"
import setup from "./gui/renderer"

export default Plugin.define({ i18n: { en }, setup, main })
