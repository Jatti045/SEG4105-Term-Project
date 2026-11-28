# Smart Inventory Fridge

Group 10's SEG 4105 term project explores how food-service teams can track refrigerated stock and reduce waste. The prototype has a manager dashboard with six tabs: current stock by category, the product catalog (inventory), a floor plan of the restaurant's fridges with item search and a kitchen editor, stock history reports, alerts, and alert rules. A fridge simulator sets up each fridge's rows and sends readings to the backend, and the dashboard updates live.

The app has three parts:

- **Database:** PostgreSQL in Docker. [db/init/01_schema.sql](db/init/01_schema.sql) builds the tables from the [data dictionary](docs/data-dictionary.md), and [db/init/02_seed.sql](db/init/02_seed.sql) adds sample data.
- **Backend:** a Python [FastAPI](https://fastapi.tiangolo.com/) service in [backend/](backend/) that serves JSON under `/api`.
- **Frontend:** a React app in [frontend/](frontend/), built and served with Vite (Node.js).

## Run locally

You need Docker, Python 3.11+, and Node.js 20+.

1. Start the database from the project root:

   ```sh
   docker compose up -d
   ```

   PostgreSQL listens on `localhost:5440`. The database, user, and password are all `smart_fridge`; override them with `POSTGRES_*` values in a `.env` file. The init scripts run only when the data volume is first created, so after changing them (or to refresh the sample dates), run `docker compose down -v` and start again.

2. Start the backend on port 8000:

   ```sh
   cd backend
   python -m venv .venv
   .venv/Scripts/activate      # macOS/Linux: source .venv/bin/activate
   pip install -r requirements.txt
   uvicorn main:app --reload --port 8000
   ```

   Set `DATABASE_URL` if the database isn't at the default address.

3. Start the frontend in another terminal:

   ```sh
   cd frontend
   npm install
   npm run dev
   ```

4. Open <http://localhost:5173> for the dashboard and <http://localhost:5173/simulator.html> for the fridge simulator. Vite forwards `/api` requests to the backend.

There is no login yet. Every request acts as the first active user with the `manager` role (Morgan Lee in the sample data).

## Fridge API

### Row setup

Managers maintain the product catalog on the dashboard's **Inventory** tab. Each fridge decides which product each of its rows holds:

- `GET /api/products` returns the catalog the fridge pulls to set up its rows.
- `GET /api/fridges/{fridge_id}/configuration` returns each row and its `product_id`.
- `PUT /api/fridges/{fridge_id}/configuration` with `{"rows": [{"row_id": 4, "product_id": 3}, ...]}` saves the fridge's setup. `null` unassigns a row; rows left out keep their product. When a row switches product, its listed items are marked removed, and the next reading adds the new product's items.

### Readings

Each time its door closes, a fridge sends a snapshot of every row to `POST /api/fridges/{fridge_id}/readings`: the weight on each row's scale and a PNG image of the row. The fridge does no processing ([ADR-001](docs/decisions/ADR-001-cloud-image-recognition.md)). For each row, the backend:

1. Takes the product the row is set up for. An unassigned row takes the product the image shows, if it's in the catalog.
2. Estimates the item count from the weight and the product's unit weight, counting one partly used item.
3. Brings the records in line:
   - **More items than listed:** adds new items, with expiry set to the reading date plus the product's shelf life.
   - **Fewer items:** removes the soonest-expiring items first. Expired ones are logged as waste detected by the system; the rest count as used.
   - **Unassigned row, unknown item:** records the weight only.
4. Checks the image against the row's setup (see [Image recognition](#image-recognition-mock)) and reports `image_matches: false` if they disagree.

It also marks the fridge online and runs the expiry, low-stock, and weight checks. A reading is applied in full or not at all, and a reading older than the fridge's last one is rejected.

Send it as `multipart/form-data`: a `reading` field with JSON, plus an `image_<row_id>` PNG for each row. `taken_at` (UTC) is optional and defaults to now.

```sh
curl http://localhost:8000/api/fridges/1/readings \
  -F 'reading={"rows": [{"row_id": 4, "weight_g": 14700}, {"row_id": 3, "weight_g": 0}]}' \
  -F image_4=@backend/mock_model/images/milk_2l.png \
  -F image_3=@backend/mock_model/images/empty.png
```

The response lists what changed in each row and any rows the reading left out. `GET /api/fridges` lists each fridge's rows with their IDs. The backend's interactive API docs are at <http://localhost:8000/docs>. There is no device authentication yet.

## Image recognition (mock)

There is no trained model yet. The mock in [backend/recognition.py](backend/recognition.py) knows a fixed set of sample images in [backend/mock_model/images/](backend/mock_model/images/): one per product, plus an empty shelf. Each image has one set output in [outputs.json](backend/mock_model/outputs.json), such as `{"label": "milk_2l", "confidence": 0.97}`. An uploaded PNG is matched to a sample by its exact bytes; any other image is not recognized.

- `POST /api/recognition` with an `image` file runs the model on one PNG and returns its output.
- `GET /api/recognition/samples` lists the sample images and their outputs.

To change the set, edit `outputs.json` and run `python scripts/make_mock_images.py` to redraw the images. A real model replaces `recognize_image()`; the APIs stay the same.

## Fridge simulator

<http://localhost:5173/simulator.html> stands in for the fridge hardware. Pick a fridge, then for each row choose the product it's set up for (from the catalog the fridge pulls), take items out or put them in, and set how full the opened item is. **Close door & send reading** sends the fridge's row setup, then each row's sample image and its weight, and shows what changed. A product the mock model has no image for sends an image it can't recognize, so its readings rely on the row's setup.

With the dashboard open in another tab, it reloads after every reading. Items thrown out on the dashboard also disappear from the simulator.

## Lab 8 teammate handoff

Start with [issue #1](https://github.com/Jatti045/SEG4105-Term-Project/issues/1) for the four assignments, branch commands, pull request targets, and screenshots to capture.
