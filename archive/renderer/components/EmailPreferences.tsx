import React from 'react';
import { toast } from 'sonner';

export default function EmailPreferences() {
  const handleUpdate = async () => {
    try {
      toast.success('Email preferences updated successfully');
    } catch (error) {
      toast.error('Failed to update email preferences');
      console.error(error);
    }
  };

  return <div>Email Preferences</div>;
}