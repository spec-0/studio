# Test an API end to end

1. Find the API with `list_local_apis` (if it isn't there, add it with `open_spec`) and list its operations with `search_operations` (pass `api` and no query) or read `get_api_spec`.
2. Start a local mock with `start_local_mock`, unless the developer named a server to test against.
3. Create a collection with `create_collection` for the main flow, for example create, read, update, then delete.
4. Add each call with `add_step`, pointing it at the mock or the server the developer named.
5. Pass values between steps with `link_value`, such as the id the create step returned, instead of typing them in.
6. Add one or two failure cases, such as reading an item after it was deleted, and set what they should return with `set_expected_status`.
7. Run it with `run_collection`.
8. Report what passed, what failed and why. Read `get_run_log` for the details of a failed step.
9. Offer to save the collection to a folder with `save_collection_to_folder`, so it can be kept with the code.
