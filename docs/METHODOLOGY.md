# Development Methodology

## 1. Software Development Lifecycle

- **Development Approach:** The Smart Inventory Fridge project follows an iterative and incremental development approach. The system is developed in stages, allowing the team to implement, evaluate, and improve features progressively.

- **Planning and Task Management:** Project requirements are divided into manageable tasks and assigned to team members. GitHub Issues is used to track tasks, while pull requests support collaboration and integration.

- **Current Implementation:** The initial prototype is a Python-based HTTP service that provides simulated inventory data, stock levels, low-stock alerts, and expiry warnings.

- **Future Development:** Planned improvements include physical fridge sensors, cloud synchronization, and a user dashboard.

- **Development Workflow:**
  1. Identify project requirements and tasks.
  2. Assign responsibilities to team members.
  3. Create individual Git branches.
  4. Implement code or documentation changes.
  5. Verify changes through appropriate testing and review.
  6. Submit pull requests for integration.

## 2. Version Control and Branching

- **Version Control System:** Git is used to manage source code and documentation changes, while GitHub serves as the remote repository.

- **Branching Strategy:** The team uses a feature-branch workflow inspired by GitHub Flow. Individual branches allow team members to work independently without directly modifying the main branch.

- **Main Branch:** `main` contains the integrated project baseline.

- **Development Branches:** Branches such as `feature/*`, `fix/*`, and `docs/*` are used for implementing features, correcting issues, and updating documentation.

- **Documentation Integration:** The `docs/architecture-and-methodology` branch collects documentation contributions before they are merged into `main`.

- **Commit Conventions:** Descriptive commit messages are used to explain changes. Suggested prefixes include `feat:`, `fix:`, `docs:`, and `test:`.

- **Pull Requests:** Each contributor submits a pull request for review before their changes are integrated into the shared branch.

## 3. Code Review and Definition of Done

Code reviews help maintain consistency, correctness, and documentation quality. GitHub pull requests are used to inspect changes and provide feedback before merging.

**Code Review Process:**
1. A contributor completes their assigned changes on an individual branch.
2. The contributor commits and pushes the changes to GitHub.
3. A pull request is created against the appropriate integration branch.
4. Another team member reviews the changes for correctness, readability, and compliance with requirements.
5. Any identified problems are corrected before merging.

**Definition of Done (DoD):**
- The assigned requirements have been implemented or documented.
- The code runs locally without known errors or regressions.
- Relevant tests or verification checks have been completed.
- Documentation is accurate and updated where necessary.
- Changes have been reviewed through a pull request.
- The approved changes are ready for integration.

## 4. Testing and Quality Assurance

Testing and quality assurance help verify that the Smart Inventory Fridge prototype behaves as expected.

- **Unit Testing:** Unit tests are planned for the Python `inventory(today)` function. These will verify inventory quantities, low-stock detection, and expiry-status classification.

- **Low-Stock Verification:** Items with quantities of two or fewer should be marked as low stock.

- **Expiry Verification:** Items with past expiry dates should be classified as expired, while items expiring within two days should be identified as expiring soon.

- **Integration Testing:** The application's HTTP endpoints can be tested to verify communication between the request handler and inventory-processing logic.

- **API Verification:** The `/health` endpoint should return a successful service status, while `/inventory` should return simulated inventory information in JSON format. Invalid routes should return HTTP 404.

- **System Testing:** The prototype can be started locally using `python3 app.py` and accessed through `http://localhost:8080/inventory`.

- **Container Testing:** Docker image building and container execution are verified separately as part of the Lab 8 containerization workflow.

- **Documentation Quality Assurance:** Markdown formatting, repository links, technical accuracy, and consistency across documentation files are reviewed before final submission.

**Current Testing Status:** The prototype supports manual verification of its HTTP endpoints and inventory functionality. Automated unit and integration tests are proposed improvements rather than completed features.