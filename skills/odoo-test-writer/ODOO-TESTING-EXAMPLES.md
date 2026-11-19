# Odoo Testing Examples

These examples are templates. Adapt model names, XML IDs, users, fields, and fixtures to the target addon.

## Shared Fixtures In `tests/common.py`

```python
from unittest.mock import MagicMock

from odoo.addons.account.tests.common import AccountTestInvoicingCommon


class YourModuleTestCommon(AccountTestInvoicingCommon):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        cls.test_partner = cls.env["res.partner"].create({
            "name": "Test Partner",
            "email": "test@example.com",
        })

        cls.approver = cls.env["res.users"].create({
            "name": "Test Approver",
            "login": "test_approver",
            "email": "approver@example.com",
            "groups_id": [(6, 0, [cls.env.ref("base.group_user").id])],
        })

        cls.env["ir.config_parameter"].sudo().set_param(
            "your_module.api_token",
            "test_token_12345",
        )

    @classmethod
    def _mock_api_requests(cls):
        mock_post = MagicMock()
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {
            "status": "success",
            "data": {"id": "test_id_123"},
        }

        mock_get = MagicMock()
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {
            "status": "success",
            "data": {"state": "completed"},
        }

        return mock_post, mock_get

    @classmethod
    def _create_test_invoice(cls, amount=1000.0):
        return cls.env["account.move"].create({
            "move_type": "out_invoice",
            "partner_id": cls.partner_a.id,
            "invoice_date": "2025-01-15",
            "invoice_line_ids": [(0, 0, {
                "product_id": cls.product_a.id,
                "quantity": 1,
                "price_unit": amount,
            })],
        })
```

## Basic Business Logic Test

```python
from odoo.exceptions import ValidationError
from odoo.tests import tagged

from .common import YourModuleTestCommon


@tagged("post_install", "-at_install")
class TestYourFeature(YourModuleTestCommon):
    def test_01_basic_functionality(self):
        record = self.env["your.model"].create({
            "name": "Test Record",
            "value": 100,
        })

        result = record.your_method()

        self.assertEqual(result, "expected_value")
        self.assertTrue(record.computed_field)

    def test_02_validation_error(self):
        with self.assertRaises(ValidationError):
            self.env["your.model"].create({
                "name": "Invalid",
                "value": -1,
            })
```

## Workflow And Activity Test

```python
def test_approval_creates_activity(self):
    record = self.env["your.model"].create({"name": "Test Record"})

    record.action_request_approval()

    activities = self.env["mail.activity"].search([
        ("res_id", "=", record.id),
        ("res_model", "=", "your.model"),
    ])

    self.assertEqual(len(activities), 1)
    self.assertEqual(activities.user_id, self.approver)
    self.assertIn("approval", activities.summary.lower())
```

## Access Rights Test

```python
from odoo.exceptions import AccessError


def test_user_cannot_delete_approved_records(self):
    record = self.env["your.model"].create({
        "name": "Test",
        "state": "approved",
    })

    with self.assertRaises(AccessError):
        record.with_user(self.approver).unlink()
```

## Mocked API Success And Failure

```python
from unittest.mock import patch

from odoo.tests import tagged

from .common import YourModuleTestCommon


@tagged("post_install", "-at_install")
class TestYourAPIIntegration(YourModuleTestCommon):
    @patch("requests.post")
    @patch("requests.get")
    def test_01_api_integration_success(self, mock_get, mock_post):
        mock_post_resp, mock_get_resp = self._mock_api_requests()
        mock_post.return_value = mock_post_resp.return_value
        mock_get.return_value = mock_get_resp.return_value

        invoice = self._create_test_invoice(amount=2000.0)

        invoice.action_send_to_external_system()

        self.assertEqual(invoice.external_status, "sent")
        self.assertTrue(invoice.external_id)
        mock_post.assert_called_once()

    @patch("requests.post")
    def test_02_api_timeout_handling(self, mock_post):
        import requests

        mock_post.side_effect = requests.Timeout("Connection timeout")
        invoice = self._create_test_invoice()

        result = invoice.action_send_to_external_system()

        self.assertFalse(result)
        self.assertIn("timeout", invoice.error_message.lower())
```

## Dynamic Mock Response

```python
from unittest.mock import MagicMock, patch


@patch("requests.post")
def test_api_with_dynamic_response(self, mock_post):
    def side_effect(*args, **kwargs):
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "approved": kwargs["json"]["amount"] > 5000,
        }
        return response

    mock_post.side_effect = side_effect

    record_high = self._create_test_invoice(amount=6000)
    record_high.action_send_to_api()
    self.assertTrue(record_high.is_approved)

    record_low = self._create_test_invoice(amount=1000)
    record_low.action_send_to_api()
    self.assertFalse(record_low.is_approved)
```

## Form Helper With One2many

```python
from odoo.tests.common import Form


def test_adding_order_lines_with_form(self):
    with Form(self.env["sale.order"]) as order_form:
        order_form.partner_id = self.partner_a

        with order_form.order_line.new() as line:
            line.product_id = self.product_a
            line.product_uom_qty = 2

        with order_form.order_line.new() as line:
            line.product_id = self.product_b
            line.product_uom_qty = 5

        with order_form.order_line.edit(0) as line:
            line.product_uom_qty = 3

        order_form.order_line.remove(index=1)

    order = order_form.record
    self.assertEqual(len(order.order_line), 1)
    self.assertEqual(order.order_line.product_uom_qty, 3)
```

## Query Count Test

```python
def test_avoid_n_plus_one_queries(self):
    invoices = self.env["account.move"].create([{
        "move_type": "out_invoice",
        "partner_id": self.partner_a.id,
        "invoice_line_ids": [(0, 0, {
            "product_id": self.product_a.id,
            "price_unit": 100,
        })],
    } for _index in range(10)])

    with self.assertQueryCount(__limit__=5):
        total = sum(invoices.mapped("amount_total"))

    self.assertTrue(total)
```

## HttpCase Smoke Test

```python
from odoo.tests import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestWebsiteFlow(HttpCase):
    def test_01_url_open(self):
        response = self.url_open("/web/login")
        self.assertEqual(response.status_code, 200)

        self.authenticate("admin", "admin")
        response = self.url_open("/web")
        self.assertEqual(response.status_code, 200)
```

## SingleTransactionCase For Read-Only Checks

```python
from odoo.tests import SingleTransactionCase, tagged


@tagged("post_install", "-at_install")
class TestReadOnlyOperations(SingleTransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.large_dataset = cls.env["your.model"].create([
            {"name": f"Record {index}"} for index in range(1000)
        ])

    def test_01_count_records(self):
        self.assertEqual(len(self.large_dataset), 1000)
```
