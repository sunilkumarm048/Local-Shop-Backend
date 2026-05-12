import mongoose from 'mongoose';

const withdrawRequestSchema = new mongoose.Schema(
  {
    deliveryPartner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 1 },

    method: { type: String, enum: ['upi', 'bank'], default: 'upi' },
    upiId: String,
    bankDetails: {
      accountName: String,
      accountNumber: String,
      ifsc: String,
    },

    status: {
      type: String,
      enum: ['pending', 'approved', 'paid', 'rejected'],
      default: 'pending',
      index: true,
    },

    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    processedAt: Date,
    transactionRef: String,
    rejectionReason: String,
  },
  { timestamps: true }
);

export default mongoose.model('WithdrawRequest', withdrawRequestSchema);
