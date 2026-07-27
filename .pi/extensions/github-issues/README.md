# GitHub Issues Extension for pi-coding-agent

This extension provides GitHub issue management tools for Yeetomatic and direct pi-agent workflows.

## Installation

The extension is located at `.pi/extensions/github-issues.ts` in this project. It will be auto-loaded by pi when running in this directory.

## Requirements

- `GITHUB_TOKEN` environment variable must be set with a valid GitHub personal access token
- Token needs `repo` scope for private repositories, or `public_repo` for public repositories only

## Tools

### github_query_issues

Search/query for issues with filters.

**Parameters:**
- `owner` (required): GitHub repository owner (username or organization)
- `repo` (required): GitHub repository name
- `state` (optional): Filter by state - "open", "closed", or "all" (default: "open")
- `labels` (optional): Filter by labels (array, must match all)
- `assignee` (optional): Filter by assignee username
- `creator` (optional): Filter by issue creator username
- `mentioned` (optional): Filter by mentioned username
- `since` (optional): Filter by date (ISO 8601 format: YYYY-MM-DD)
- `limit` (optional): Maximum number of issues to return (default: 10)

**Returns:**
- Array of issues with: number, title, body, labels, state, created_at, updated_at

**Example:**
```
github_query_issues owner="mariozechner" repo="pi-coding-agent" state="open" labels=["bug"] limit=5
```

### github_fetch_issue

Get full details of a single issue including comments.

**Parameters:**
- `owner` (required): GitHub repository owner
- `repo` (required): GitHub repository name
- `issue_number` (required): Issue number
- `include_comments` (optional): Include comments (default: true)

**Returns:**
- Issue object with full body, labels, assignees, and optionally comments

**Example:**
```
github_fetch_issue owner="mariozechner" repo="pi-coding-agent" issue_number=42
```

### github_set_comment

Add a comment to an issue.

**Parameters:**
- `owner` (required): GitHub repository owner
- `repo` (required): GitHub repository name
- `issue_number` (required): Issue number
- `body` (required): Comment text (Markdown supported)

**Returns:**
- Comment URL, comment ID, success confirmation

**Example:**
```
github_set_comment owner="mariozechner" repo="pi-coding-agent" issue_number=42 body="Working on this now..."
```

### github_set_status

Update issue state (open/close) and/or assignee.

**Parameters:**
- `owner` (required): GitHub repository owner
- `repo` (required): GitHub repository name
- `issue_number` (required): Issue number
- `state` (optional): Set issue state - "open" or "closed"
- `assignee` (optional): Set assignee username (null to unassign)

**Returns:**
- Updated issue state, assignees list

**Example:**
```
github_set_status owner="mariozechner" repo="pi-coding-agent" issue_number=42 state="closed" assignee="mbrooks"
```

### github_set_labels

Add/remove labels on an issue.

**Parameters:**
- `owner` (required): GitHub repository owner
- `repo` (required): GitHub repository name
- `issue_number` (required): Issue number
- `labels` (optional): Replace all labels with this array
- `addLabels` (optional): Add these labels to existing labels
- `removeLabels` (optional): Remove these labels from existing labels

**Returns:**
- Updated label list

**Example:**
```
github_set_labels owner="mariozechner" repo="pi-coding-agent" issue_number=42 addLabels=["in-progress"] removeLabels=["needs-triage"]
```

## Configuration

Set the `GITHUB_TOKEN` environment variable:

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

Or add it to your `.env` file:

```
GITHUB_TOKEN=ghp_your_token_here
```

## Creating a GitHub Token

1. Go to GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a descriptive name (e.g., "pi-coding-agent")
4. Select scopes:
   - `repo` (full control of private repositories) - for private repos
   - `public_repo` (only public repositories) - for public repos only
5. Click "Generate token"
6. Copy the token and store it securely

## Usage with Yeetomatic

Yeetomatic can use these tools to autonomously manage GitHub issues:

1. Query for open issues: `github_query_issues owner="..." repo="..." state="open"`
2. Fetch issue details: `github_fetch_issue owner="..." repo="..." issue_number=123`
3. Add status comments: `github_set_comment owner="..." repo="..." issue_number=123 body="..."`
4. Update status: `github_set_status owner="..." repo="..." issue_number=123 state="closed"`
5. Manage labels: `github_set_labels owner="..." repo="..." issue_number=123 addLabels=["completed"]`

## Error Handling

All tools return error information in the `details.error` field when something goes wrong. Common errors:

- `GITHUB_TOKEN environment variable is not set` - Token not configured
- `Invalid owner/repo` - Repository name format issue
- HTTP errors from GitHub API (404, 403, etc.)
