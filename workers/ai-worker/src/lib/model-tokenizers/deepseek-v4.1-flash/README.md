# DeepSeek V4.1 Flash tokenizer

Plain tokenizer data from the official `deepseek-ai/DeepSeek-V4.1-Flash` repository, revision `2cba9e4`, MIT license. Model weights and remote Python code are not included or executed.

- [tokenizer.json](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/2cba9e4/tokenizer.json), SHA-256 `c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b`
- [tokenizer_config.json](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/2cba9e4/tokenizer_config.json), SHA-256 `6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547`

The worker uses `@huggingface/tokenizers` 0.2.0 for text counting. Roles, tool envelopes and opaque inputs still have their own protocol overhead / floors, and the budget reserves its overhead margin. Unsupported models use the core's UTF-8 bound rather than assuming three ASCII characters per token.
