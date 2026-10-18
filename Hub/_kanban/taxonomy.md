# Board schema

Type choices come from the folders directly under Hub. Excludes Attachments and names starting with _ or .

```json
{
  "version": 1,
  "category_source": "hub-folders",
  "columns": [
    "backlog",
    "in-progress",
    "done"
  ],
  "priorities": [
    "urgent",
    "high",
    "medium",
    "low"
  ],
  "categories": [],
  "folder_to_category": {},
  "excluded_folders": [
    "Attachments"
  ],
  "view_to_folder": {},
  "wip_limit": 3,
  "default_body": "## Next step\n\n\n## Done when\n\n"
}
```
