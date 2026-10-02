// The two example dispatch payloads from Delivery Hero's POS Plugin API spec
// (pluginOrder.yaml → genericOrderExample, orderWithItemLevelDiscountsAndSponsor),
// converted from YAML verbatim. They are illustrative rather than arithmetically
// consistent — the tests assert what we do with them, not that they add up.

export const GENERIC_ORDER_EXAMPLE = {
  "token": "5f373562-591a-4db9-8609-7eec7880f28d",
  "code": "n0s1-w0k1",
  "comments": {
    "customerComment": "Please hurry, I am hungry"
  },
  "createdAt": "2016-03-14T17:00:00.000Z",
  "customer": {
    "email": "s188sduisddsnjknsj",
    "firstName": "food",
    "lastName": "panda",
    "mobilePhone": "+49 99999999",
    "flags": [
      "string"
    ],
    "invoiceAddress": {
      "postcode": "10117",
      "city": "Berlin",
      "street": "Oranienburger Sta\u00dfe",
      "number": "67"
    }
  },
  "delivery": {
    "address": {
      "postcode": "10117",
      "city": "Berlin",
      "street": "Oranienburger Sta\u00dfe",
      "number": "67"
    },
    "expectedDeliveryTime": "2016-03-14T17:50:00.000Z",
    "expressDelivery": false,
    "riderPickupTime": "2016-03-14T17:35:00.000Z"
  },
  "discounts": [
    {
      "name": "First Order",
      "amount": "9.00",
      "sponsorships": [
        {
          "sponsor": "PLATFORM",
          "amount": "3"
        },
        {
          "sponsor": "VENDOR",
          "amount": "3"
        },
        {
          "sponsor": "THIRD_PARTY",
          "amount": "3"
        }
      ]
    }
  ],
  "expeditionType": "pickup",
  "expiryDate": "2016-03-14T17:15:00.000Z",
  "extraParameters": {
    "property1": "string",
    "property2": "string"
  },
  "invoicingInformation": {
    "carrierType": "string",
    "carrierValue": "string"
  },
  "localInfo": {
    "countryCode": "DE",
    "currencySymbol": "\u20ac",
    "platform": "Foodpanda",
    "platformKey": "FP_DE"
  },
  "payment": {
    "status": "paid",
    "type": "paid"
  },
  "test": false,
  "shortCode": "42",
  "preOrder": false,
  "pickup": null,
  "platformRestaurant": {
    "id": "sq-abcd"
  },
  "price": {
    "deliveryFees": [
      {
        "name": "packaging fee",
        "value": 2.5
      }
    ],
    "grandTotal": "25.50",
    "payRestaurant": "25.50",
    "riderTip": "1.20",
    "totalNet": "19.45",
    "vatTotal": "2.50",
    "collectFromCustomer": "16.34"
  },
  "products": [
    {
      "categoryName": "Burgers",
      "name": "Double Cheese Burger",
      "paidPrice": "8.00",
      "quantity": "string",
      "remoteCode": "ID_FOR_DOUBLE_CHEESE_BURGER_ON_POS",
      "sku": "SKU_FOR_DOUBLE_CHEESE_BURGER_ON_POS",
      "selectedToppings": [
        {
          "children": [],
          "name": "extra cheese",
          "price": "1.50",
          "quantity": 1,
          "id": "ID_FOR_EXTRA_CHEESE_ON_PLATFORM",
          "remoteCode": "ID_FOR_EXTRA_CHEESE_ON_POS",
          "sku": "SKU_FOR_EXTRA_CHEESE_ON_POS",
          "type": "PRODUCT",
          "itemUnavailabilityHandling": "REMOVE",
          "discounts": [
            {
              "name": "First order",
              "amount": "1.50",
              "sponsorships": [
                {
                  "sponsor": "PLATFORM",
                  "amount": "0.50"
                },
                {
                  "sponsor": "VENDOR",
                  "amount": "0.50"
                },
                {
                  "sponsor": "THIRD_PARTY",
                  "amount": "0.50"
                }
              ]
            }
          ]
        }
      ],
      "unitPrice": "6.42",
      "comment": "No cheese please",
      "id": "ID_FOR_DOUBLE_CHEESE_BURGER_ON_PLATFORM",
      "itemUnavailabilityHandling": "CALL_CUSTOMER_AND_REPLACE",
      "variation": {
        "name": "Double Cheese Burger"
      },
      "discounts": [
        {
          "name": "First order",
          "amount": "1.50",
          "sponsorships": [
            {
              "sponsor": "PLATFORM",
              "amount": "1.50"
            },
            {
              "sponsor": "VENDOR",
              "amount": "1.50"
            },
            {
              "sponsor": "THIRD_PARTY",
              "amount": "1.50"
            }
          ]
        }
      ]
    }
  ],
  "corporateTaxId": "example-tax-id",
  "callbackUrls": {
    "orderAcceptedUrl": "string",
    "orderRejectedUrl": "string",
    "orderPickedUpUrl": "string",
    "orderPreparedUrl": "string",
    "orderProductModificationUrl": "string",
    "orderPreparationTimeAdjustmentUrl": "string"
  }
} as any;

export const ITEM_LEVEL_DISCOUNT_EXAMPLE = {
  "token": "logistics-vendor-one-_-oma_vendor-one-order-one",
  "code": "platform_one-platform_vendor_one",
  "shortCode": "1111",
  "preOrder": false,
  "expiryDate": "2023-03-05T20:40:00.000Z",
  "createdAt": "2023-03-05T20:40:00.000Z",
  "localInfo": {
    "platform": "platform_one",
    "platformKey": "platform_one",
    "countryCode": "de",
    "currencySymbol": "\u20ac",
    "currencySymbolPosition": "",
    "currencySymbolSpaces": "",
    "decimalSeparator": ".",
    "decimalDigits": "",
    "thousandsSeparator": "",
    "website": "",
    "email": "",
    "phone": ""
  },
  "platformRestaurant": {
    "id": "platform_vendor_one"
  },
  "customer": {
    "id": "customer_id_one",
    "code": "customer_id_one",
    "mobilePhone": "+4903023125000",
    "firstName": "first-name",
    "lastName": "last-name",
    "email": "",
    "mobilePhoneCountryCode": "",
    "flags": []
  },
  "payment": {
    "type": "credit-card",
    "remoteCode": "credit-card",
    "status": "pending",
    "requiredMoneyChange": "",
    "vatName": "",
    "vatId": ""
  },
  "expeditionType": "delivery",
  "products": [
    {
      "id": "platform-product-id-one",
      "remoteCode": "remote-product-code-one",
      "name": "Cheese Burger",
      "description": "",
      "comment": "",
      "categoryName": "",
      "variation": {
        "name": "Cheese Burger"
      },
      "unitPrice": "2.50",
      "paidPrice": "10.00",
      "discountAmount": "",
      "quantity": "4",
      "halfHalf": false,
      "vatPercentage": "",
      "discounts": [
        {
          "name": "First Order",
          "amount": "3.00",
          "sponsorships": [
            {
              "sponsor": "PLATFORM",
              "amount": "1.00"
            },
            {
              "sponsor": "VENDOR",
              "amount": "1.00"
            },
            {
              "sponsor": "THIRD_PARTY",
              "amount": "1.00"
            }
          ]
        },
        {
          "name": "Burger Hour",
          "amount": "1.00",
          "sponsorships": [
            {
              "sponsor": "VENDOR",
              "amount": "1.00"
            }
          ]
        }
      ],
      "selectedChoices": [],
      "selectedToppings": [
        {
          "children": [],
          "name": "extra cheese",
          "price": "1.50",
          "quantity": 1,
          "id": "ID_FOR_EXTRA_CHEESE_ON_PLATFORM",
          "remoteCode": "ID_FOR_EXTRA_CHEESE_ON_POS",
          "type": "PRODUCT",
          "discounts": [
            {
              "name": "First Order",
              "amount": "1.50",
              "sponsorships": [
                {
                  "sponsor": "PLATFORM",
                  "amount": "0.50"
                },
                {
                  "sponsor": "VENDOR",
                  "amount": "0.50"
                },
                {
                  "sponsor": "THIRD_PARTY",
                  "amount": "0.50"
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "corporateTaxId": "",
  "comments": {
    "customerComment": "some customer comment",
    "vendorComment": ""
  },
  "vouchers": [],
  "discounts": [
    {
      "name": "First Order",
      "amount": "4.50",
      "sponsorships": [
        {
          "sponsor": "PLATFORM",
          "amount": "1.50"
        },
        {
          "sponsor": "VENDOR",
          "amount": "1.50"
        },
        {
          "sponsor": "THIRD_PARTY",
          "amount": "1.50"
        }
      ]
    },
    {
      "name": "Online Payment",
      "amount": "1.00",
      "sponsorships": [
        {
          "sponsor": "PLATFORM",
          "amount": "1.00"
        }
      ]
    },
    {
      "name": "Burger Hour",
      "amount": "1.00",
      "sponsorships": [
        {
          "sponsor": "VENDOR",
          "amount": "1.00"
        }
      ]
    }
  ],
  "price": {
    "minimumDeliveryValue": "",
    "comission": "",
    "deliveryFee": "3",
    "deliveryFees": [
      {
        "name": "DeliveryFee",
        "value": 3
      }
    ],
    "containerCharge": "",
    "deliveryFeeDiscount": "",
    "serviceFeePercent": "",
    "serviceFeeTotal": "",
    "serviceTax": 0,
    "serviceTaxValue": 0,
    "subTotal": "10",
    "totalNet": "13",
    "vatVisible": true,
    "vatPercent": "0.00",
    "vatTotal": "0.00",
    "grandTotal": "10",
    "discountAmountTotal": "3",
    "differenceToMinimumDeliveryValue": "",
    "payRestaurant": "0",
    "collectFromCustomer": "10",
    "riderTip": "0"
  },
  "webOrder": false,
  "mobileOrder": true,
  "corporateOrder": false,
  "integrationInfo": {},
  "test": false,
  "delivery": {
    "expressDelivery": false,
    "expectedDeliveryTime": "2023-03-05T20:55:00.000Z",
    "riderPickupTime": null,
    "address": {
      "line1": "",
      "line2": "",
      "line3": "",
      "line4": "",
      "line5": "",
      "street": "Oranienburger Str.",
      "number": "70",
      "room": "",
      "flatNumber": "",
      "building": "",
      "intercom": "",
      "entrance": "",
      "structure": "",
      "floor": "",
      "district": "",
      "other": "",
      "city": "Berlin",
      "postcode": "",
      "company": "",
      "deliveryMainArea": "",
      "deliveryMainAreaPostcode": "",
      "deliveryArea": "",
      "deliveryAreaPostcode": "",
      "deliveryInstructions": "",
      "latitude": 50.0710387,
      "longitude": 14.4650663
    }
  }
} as any;
