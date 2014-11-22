class AddPositionToGifts < ActiveRecord::Migration
  def change
    change_table :gifts do |t|
      t.integer :position
    end
  end
end
