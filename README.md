# ubereats-worker

Playwright worker for reading Uber Eats group order carts.

## Endpoints

### GET /health
Health check.

### POST /cookies
Update login cookies.
Body:
{
  "cookies": [ ... ]
}

### POST /scrape
Read group order carts.
Body:
{
  "urls": ["https://eats.uber.com/..."]
}
