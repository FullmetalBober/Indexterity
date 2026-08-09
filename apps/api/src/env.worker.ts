// Validate the environment for the worker process, before anything reads it.
//
// A narrower schema than the api's, and deliberately so. The worker serves no
// HTTP and is never given BETTER_AUTH_SECRET, WEB_ORIGIN or the rate limits —
// the chart's worker Deployment sets none of them — so demanding them would fail
// every install. What it does gain is MASTER_KEY: without it this process used
// to start cleanly and fail at the first job that opened a cluster, as a decrypt
// error hours after the deploy that caused it (#126).
import { loadEnvOrExit } from "./config/env";

loadEnvOrExit("worker");
