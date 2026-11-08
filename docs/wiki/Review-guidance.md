# Review guidance

The [review example](https://github.com/lunchbox-labs/opencode-prompt-composer/tree/main/docs/examples/review) contains a native `review` agent, a `/check` command and shared prompt snippets. Register the plugin in your OpenCode configuration and open the example project.

The agent includes review context before its task and the findings format within its body. `/check` uses the same findings snippet after `Review $ARGUMENTS.`. These inline includes determine ordering; there is no separate agent-rule settings file. The repository example files are the complete, runnable source.

Select `review` or run `/check`, and use `/view-prompts` to inspect the loaded agent and command text. After changing snippets, restart the OpenCode server. To override a shared snippet, use the same relative filename in a later prompt root; see [Discovery](Discovery).
