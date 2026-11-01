import { defineConfig } from "vite-plus";
import main from "./vitest.main.config";
import { filesForSuite } from "./config/test-suites";

const { include, exclude } = filesForSuite("host");
export default defineConfig({ ...main, test: { ...main.test, include, exclude } });
